import { getDB } from "../database";
import {
  classifyDispatchError,
  evaluateDispatchCampaignRisk,
  evaluateDispatchPolicy,
  evaluateDispatchSessionHealth,
  recordDispatchContactEvent,
} from "../services/dispatchPolicy";
import { appendConversationHistoryEntries } from "../services/conversationHistoryService";
import { isInSilenceWindow } from "../services/silenceUtils";
import { getFollowUpSettings, getFollowUpItemById, generateFollowUpMessage, scheduleNextWarmFollowUp, markFollowUpItem, addFollowUpAttempt, getNextFollowUpWindowTimestamp } from "../services/followUpService";
import { assertSessionCanSend, recordSessionSend, SessionRateLimitError } from "../utils/humanDelay";
import { withTimeout } from "../utils/withTimeout";
import { ensureChat, getClient } from "../wppManager";

const IDLE_MS = Math.max(5_000, Number(process.env.FOLLOW_UP_WORKER_IDLE_MS || 15_000));
const PROCESSING_TIMEOUT_MS = Math.max(60_000, Number(process.env.FOLLOW_UP_PROCESSING_TIMEOUT_MS || 10 * 60 * 1000));
const RETRY_DELAY_MS = Math.max(60_000, Number(process.env.FOLLOW_UP_RETRY_DELAY_MS || 30 * 60 * 1000));
const SEND_TIMEOUT_MS = Number(process.env.WPP_TIMEOUT_MS || 12_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.FOLLOW_UP_MAX_ATTEMPTS || 5));
const MAX_TEXT_CHARS = 2_000;

type WorkerState = { running: boolean; stopped: boolean; timer: NodeJS.Timeout | null };
type UserScheduleRow = { timezone_offset: number | string | null };

let sharedState: WorkerState | null = null;

function toSafeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 30);
}

function renderTemplate(template: string, values: Record<string, string>) {
  return String(template || "").replace(/{{\s*([\w.-]+)\s*}}/gi, (_match, rawKey) => {
    const key = String(rawKey || "").toLowerCase();
    return values[key] ?? "";
  }).trim().slice(0, MAX_TEXT_CHARS);
}

async function getTimezoneOffset(userId: number) {
  const row = await getDB().get<UserScheduleRow>(
    `SELECT timezone_offset FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  return Number(row?.timezone_offset ?? -180);
}

async function localDayBounds(timestamp: number, offset: number) {
  const local = new Date(timestamp + offset * 60_000);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset * 60_000;
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

async function countSentToday(userId: number, offset: number) {
  const bounds = await localDayBounds(Date.now(), offset);
  const row = await getDB().get<{ total: number | string | null }>(
    `SELECT COUNT(*) AS total FROM follow_up_items
     WHERE user_id = ? AND kind = 'stalled' AND status = 'sent' AND sent_at >= ? AND sent_at < ?`,
    [userId, bounds.start, bounds.end]
  );
  return toSafeInt(row?.total);
}

function nextLocalDayStart(timestamp: number, offset: number, start: string) {
  const local = new Date(timestamp + offset * 60_000);
  const [hour, minute] = start.split(":").map(Number);
  const next = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
    hour,
    minute,
    0,
    0
  ));
  return next.getTime() - offset * 60_000;
}

async function spreadNextStalledSend(
  userId: number,
  settings: Awaited<ReturnType<typeof getFollowUpSettings>>,
  now: number,
  offset: number
) {
  const start = settings.sendStart.split(":").map(Number);
  const end = settings.sendEnd.split(":").map(Number);
  const windowMinutes = Math.max(60, (end[0] * 60 + end[1]) - (start[0] * 60 + start[1]));
  const gapMs = Math.floor((windowMinutes * 60_000) / Math.max(1, settings.dailyLimit));
  const queued = await getDB().all<{ id: number; due_at: number | string | null }>(
    `SELECT id, due_at FROM follow_up_items
     WHERE user_id = ? AND kind = 'stalled' AND status = 'pending'
     ORDER BY due_at ASC, id ASC`,
    [userId]
  );
  let cursor = now;
  for (const item of queued) {
    const dueAt = Number(item.due_at || 0);
    const nextCandidate = Math.max(dueAt, cursor + gapMs);
    const spacedAt = getNextFollowUpWindowTimestamp(nextCandidate, offset, settings.sendStart, settings.sendEnd);
    await getDB().run(
      `UPDATE follow_up_items SET due_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
      [spacedAt, now, item.id, userId]
    );
    cursor = spacedAt;
  }
}

async function rescheduleItem(id: number, dueAt: number, message: string) {
  await markFollowUpItem(id, "pending", { dueAt, error: message });
}

async function claimNextItem() {
  const db = getDB();
  const now = Date.now();
  const candidate = await db.get<{ id: number }>(
    `SELECT id FROM follow_up_items
     WHERE status = 'pending' AND due_at IS NOT NULL AND due_at <= ?
     ORDER BY due_at ASC, id ASC LIMIT 1`,
    [now]
  );
  if (!candidate) return null;
  const result = await db.run(
    `UPDATE follow_up_items SET status = 'processing', updated_at = ?
     WHERE id = ? AND status = 'pending' AND due_at <= ?`,
    [now, candidate.id, now]
  );
  return result.affectedRows ? Number(candidate.id) : null;
}

async function ensureStillProcessing(id: number) {
  const row = await getDB().get<{ status: string }>(
    `SELECT status FROM follow_up_items WHERE id = ? LIMIT 1`,
    [id]
  );
  return row?.status === "processing";
}

async function cancelIfContactChanged(item: NonNullable<Awaited<ReturnType<typeof getFollowUpItemById>>>) {
  const activity = await getDB().get<{ last_inbound_at: number | string | null }>(
    `SELECT last_inbound_at FROM follow_up_contact_activity
     WHERE user_id = ? AND phone = ? LIMIT 1`,
    [item.userId, item.contactPhone]
  );
  if (toSafeInt(activity?.last_inbound_at) > item.sourceActivityAt) {
    await markFollowUpItem(item.id, "cancelled", { error: "O cliente voltou a conversar antes do envio." });
    return true;
  }
  const crm = item.crmId
    ? await getDB().get<{ stage: string | null; last_seen: number | string | null }>(
        `SELECT stage, last_seen FROM crm WHERE id = ? AND user_id = ? LIMIT 1`,
        [item.crmId, item.userId]
      )
    : null;
  if (item.kind === "stalled" && !crm) {
    await markFollowUpItem(item.id, "cancelled");
    return true;
  }
  if (crm && toSafeInt(crm.last_seen) > item.sourceActivityAt) {
    await markFollowUpItem(item.id, "cancelled", { error: "O cliente voltou a conversar antes do envio." });
    return true;
  }
  if (item.kind !== "stalled" || !crm) return false;
  const stage = String(crm.stage || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (["fechado", "perdido"].includes(stage)) {
    await markFollowUpItem(item.id, "cancelled", { error: "O contato foi fechado no CRM." });
    return true;
  }
  return false;
}

async function processItem(id: number) {
  const db = getDB();
  const item = await getFollowUpItemById(id);
  if (!item || item.status !== "processing") return;
  const settings = await getFollowUpSettings(item.userId);

  if ((item.kind === "warm" && !settings.warmEnabled) || (item.kind === "stalled" && !settings.stalledEnabled)) {
    await markFollowUpItem(item.id, "cancelled", { error: "A automação foi desativada." });
    return;
  }
  if (await cancelIfContactChanged(item)) return;
  if (!(await ensureStillProcessing(item.id))) return;

  const userOffset = await getTimezoneOffset(item.userId);
  const allowedAt = getNextFollowUpWindowTimestamp(Date.now(), userOffset, settings.sendStart, settings.sendEnd);
  if (allowedAt > Date.now()) {
    await rescheduleItem(item.id, allowedAt, "Aguardando a janela de envio configurada.");
    return;
  }

  if (await isInSilenceWindow(item.userId)) {
    await rescheduleItem(item.id, Date.now() + 15 * 60_000, "Aguardando o fim do horário de silêncio configurado.");
    return;
  }

  if (item.kind === "stalled") {
    const sentToday = await countSentToday(item.userId, userOffset);
    if (sentToday >= settings.dailyLimit) {
      const nextWindow = nextLocalDayStart(Date.now(), userOffset, settings.sendStart);
      await rescheduleItem(item.id, nextWindow, "Limite diário de reengajamentos atingido.");
      return;
    }
  }

  const connected = await db.get<{ session_name: string }>(
    `SELECT session_name FROM sessions
     WHERE user_id = ? AND session_name = ? AND status = 'connected' LIMIT 1`,
    [item.userId, item.sessionName]
  );
  if (!connected) {
    await rescheduleItem(item.id, Date.now() + RETRY_DELAY_MS, "A sessão selecionada está desconectada.");
    return;
  }

  const number = normalizePhone(item.contactPhone);
  if (!number) {
    await markFollowUpItem(item.id, "failed", { error: "Número do contato inválido." });
    return;
  }

  let message = item.draftMessage;
  if (item.kind === "warm") {
    const step = settings.warmSteps[item.stepIndex];
    if (!step) {
      await markFollowUpItem(item.id, "cancelled", { error: "Esta etapa não existe mais na configuração." });
      return;
    }
    if (step.writer === "ai") {
      try {
        message = await generateFollowUpMessage({
          userId: item.userId,
          sessionName: item.sessionName,
          chatId: item.chatId,
          contactName: item.contactName,
          instruction: step.instruction,
        });
      } catch (error: any) {
        await markFollowUpItem(item.id, "failed", { error: error?.message || "Não foi possível escrever com IA." });
        return;
      }
    } else {
      const now = new Date(Date.now() + userOffset * 60_000);
      message = renderTemplate(step.message, {
        nome: item.contactName,
        name: item.contactName,
        data: now.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
        hoje: now.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
        hora: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }),
      });
    }
  }
  message = String(message || "").trim().slice(0, MAX_TEXT_CHARS);
  if (!message) {
    await markFollowUpItem(item.id, "failed", { error: "A mensagem de follow-up está vazia." });
    return;
  }

  if (!(await ensureStillProcessing(item.id))) return;
  const policy = await evaluateDispatchPolicy({
    db,
    userId: item.userId,
    contacts: [{ number, message }],
    campaignKind: "follow_up",
    preferredSession: item.sessionName,
    scheduledAt: Date.now(),
    plannedCount: 1,
    enforceContactCooldown: false,
  });
  if (policy.skippedContacts.some((entry) => entry.code === "suppressed")) {
    await markFollowUpItem(item.id, "skipped", { error: "Número em supressão ativa; nenhum envio foi feito." });
    await recordDispatchContactEvent({ userId: item.userId, sessionName: item.sessionName, campaignKind: "follow_up", campaignRef: `follow-up:${item.id}`, phone: number, status: "skipped", errorCode: "suppressed", errorMessage: "Número em supressão ativa." }, db);
    return;
  }
  if (policy.blocked || !policy.allowedContacts.length) {
    const reason = policy.blockReason || policy.skippedContacts[0]?.reason || "Envio bloqueado pela política de segurança.";
    if (/cooldown|limite|aquecimento|seguro/i.test(reason)) {
      await rescheduleItem(item.id, Date.now() + RETRY_DELAY_MS, reason);
      return;
    }
    await markFollowUpItem(item.id, "failed", { error: reason });
    return;
  }

  const sessionKey = `USER${item.userId}_${item.sessionName}`;
  const client = getClient(sessionKey);
  if (!client) {
    await rescheduleItem(item.id, Date.now() + RETRY_DELAY_MS, "A sessão do WhatsApp não está pronta.");
    return;
  }
  const health = await evaluateDispatchSessionHealth({ db, userId: item.userId, sessionName: item.sessionName });
  if (health.blocked) {
    await rescheduleItem(item.id, Date.now() + RETRY_DELAY_MS, health.reason || "Sessão temporariamente bloqueada.");
    return;
  }
  const risk = await evaluateDispatchCampaignRisk({ db, userId: item.userId, sessionName: item.sessionName, plannedCount: 1, scheduledAt: Date.now() });
  if (risk.blocked) {
    await rescheduleItem(item.id, Date.now() + RETRY_DELAY_MS, risk.reason || "Limite seguro de envio atingido.");
    return;
  }

  let sentAt = 0;
  try {
    if (!(await ensureStillProcessing(item.id))) return;
    assertSessionCanSend(sessionKey);
    const target = await ensureChat(client, number);
    if (await cancelIfContactChanged(item)) return;
    if (!(await ensureStillProcessing(item.id))) return;
    await withTimeout(client.sendText(target, message), SEND_TIMEOUT_MS, "follow-up sendText");
    sentAt = Date.now();
    recordSessionSend(sessionKey);
    await markFollowUpItem(item.id, "sent", { sentAt });
  } catch (error: any) {
    if (sentAt) {
      console.error("Mensagem de follow-up enviada, mas não foi possível atualizar o status:", error);
      await markFollowUpItem(item.id, "sent", { sentAt }).catch(() => {});
      return;
    }
    const reason = error instanceof SessionRateLimitError
      ? error.message
      : classifyDispatchError(error).message || String(error?.message || error || "Falha ao enviar.");
    await addFollowUpAttempt(item.id, reason);
    const updated = await getFollowUpItemById(item.id);
    if ((updated?.attemptCount || 0) >= MAX_ATTEMPTS) {
      await markFollowUpItem(item.id, "failed", { error: reason });
      await recordDispatchContactEvent({ userId: item.userId, sessionName: item.sessionName, campaignKind: "follow_up", campaignRef: `follow-up:${item.id}`, phone: number, status: "error", errorMessage: reason }, db);
      return;
    }
    await rescheduleItem(item.id, Date.now() + RETRY_DELAY_MS, reason);
    return;
  }

  try {
    await recordDispatchContactEvent({
      userId: item.userId,
      sessionName: item.sessionName,
      campaignKind: "follow_up",
      campaignRef: `follow-up:${item.id}`,
      phone: number,
      status: "sent",
    }, db);
  } catch (error) {
    console.warn("Não foi possível registrar o envio de follow-up na política de dispatch:", error);
  }

  try {
    await appendConversationHistoryEntries({
      userId: item.userId,
      sessionName: item.sessionName,
      chatId: item.chatId,
      entries: [{ role: "model", parts: [{ text: message }] }],
    });
  } catch (error) {
    console.warn("Não foi possível registrar o follow-up no histórico da conversa:", error);
  }

  try {
    if (item.kind === "warm") {
      await scheduleNextWarmFollowUp({
        userId: item.userId,
        crmId: item.crmId,
        sourceActivityAt: item.sourceActivityAt,
        afterStepIndex: item.stepIndex,
        sessionName: item.sessionName,
        chatId: item.chatId,
        contactName: item.contactName,
        contactPhone: item.contactPhone,
      });
    } else {
      await spreadNextStalledSend(item.userId, settings, sentAt, userOffset);
    }
  } catch (error) {
    console.error("Não foi possível preparar a próxima etapa do follow-up:", error);
  }
}

async function releaseStuckItems() {
  const threshold = Date.now() - PROCESSING_TIMEOUT_MS;
  await getDB().run(
    `UPDATE follow_up_items
     SET status = 'pending', updated_at = ?, due_at = ?
     WHERE status = 'processing' AND updated_at < ?`,
    [Date.now(), Date.now() + RETRY_DELAY_MS, threshold]
  );
}

async function run(state: WorkerState) {
  if (state.running || state.stopped) return;
  state.running = true;
  try {
    await releaseStuckItems();
    const id = await claimNextItem();
    if (id) {
      try { await processItem(id); }
      catch (error) {
        console.error("Erro inesperado no Follow-up:", error);
        const item = await getFollowUpItemById(id).catch(() => null);
        if (item?.status === "processing") {
          await markFollowUpItem(id, "pending", { dueAt: Date.now() + RETRY_DELAY_MS, error: "Falha interna ao processar o follow-up." }).catch(() => {});
        }
      }
    }
  } catch (error) {
    console.error("Erro no worker de Follow-up:", error);
  } finally {
    state.running = false;
    if (!state.stopped) {
      state.timer = setTimeout(() => void run(state), IDLE_MS);
      state.timer.unref?.();
    }
  }
}

export function startFollowUpWorker() {
  if (sharedState) return;
  sharedState = { running: false, stopped: false, timer: null };
  process.once("SIGTERM", () => {
    if (!sharedState) return;
    sharedState.stopped = true;
    if (sharedState.timer) clearTimeout(sharedState.timer);
  });
  process.once("SIGINT", () => {
    if (!sharedState) return;
    sharedState.stopped = true;
    if (sharedState.timer) clearTimeout(sharedState.timer);
  });
  void run(sharedState);
}
