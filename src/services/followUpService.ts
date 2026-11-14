import { getDB } from "../database";
import { generateAIResponse } from "./aiHandler";
import { canUseIA, consumeIaMessage } from "./iaLimiter";
import { resolveAiPrompt } from "./aiConfiguration";
import { resolveRuntimeAiProvider } from "../utils/aiProvider";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STEPS = 5;
const MAX_MESSAGE_CHARS = 2_000;

export type FollowUpWriter = "ai" | "manual";
export type FollowUpStep = {
  afterMinutes: number;
  writer: FollowUpWriter;
  message: string;
  instruction: string;
};

export type FollowUpSettings = {
  warmEnabled: boolean;
  warmSteps: FollowUpStep[];
  stalledEnabled: boolean;
  stalledAfterDays: number;
  dailyLimit: number;
  repeatAfterDays: number;
  maxRevisits: number;
  sendStart: string;
  sendEnd: string;
  preferredSession: string;
};

export type FollowUpItemStatus =
  | "pending"
  | "processing"
  | "awaiting_approval"
  | "sent"
  | "failed"
  | "cancelled"
  | "skipped";

export type FollowUpItem = {
  id: number;
  userId: number;
  crmId: number | null;
  sessionName: string;
  chatId: string;
  contactName: string;
  contactPhone: string;
  kind: "warm" | "stalled";
  stepIndex: number;
  status: FollowUpItemStatus;
  dueAt: number | null;
  draftMessage: string;
  attemptCount: number;
  lastError: string;
  sentAt: number | null;
  sourceActivityAt: number;
  createdAt: number;
};

type SettingsRow = { config: string | null };
type ItemRow = {
  id: number;
  user_id: number;
  crm_id: number | null;
  session_name: string;
  chat_id: string;
  contact_name: string | null;
  contact_phone: string;
  kind: string;
  step_index: number | string;
  status: FollowUpItemStatus;
  due_at: number | string | null;
  draft_message: string | null;
  attempt_count: number | string;
  last_error: string | null;
  sent_at: number | string | null;
  source_activity_at: number | string;
  created_at: number | string;
};

export type StalledLead = {
  crmId: number;
  name: string;
  phone: string;
  stage: string;
  lastSeenAt: number;
  dealValue: number;
  sentCount: number;
  lastSentAt: number | null;
};

const DEFAULT_SETTINGS: FollowUpSettings = {
  warmEnabled: false,
  warmSteps: [
    { afterMinutes: 60, writer: "ai", message: "", instruction: "" },
  ],
  stalledEnabled: false,
  stalledAfterDays: 7,
  dailyLimit: 20,
  repeatAfterDays: 30,
  maxRevisits: 3,
  sendStart: "08:00",
  sendEnd: "21:00",
  preferredSession: "",
};

function toSafeInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePhone(value: unknown): string {
  return String(value || "").replace(/\D/g, "").slice(0, 30);
}

function normalizeStage(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "sim"].includes(text)) return true;
  if (["0", "false", "off", "no", "nao", "não"].includes(text)) return false;
  return fallback;
}

function normalizeClock(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeStep(value: unknown, index: number): FollowUpStep {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    afterMinutes: Math.max(1, Math.min(43_200, toSafeInt(raw.afterMinutes, index === 0 ? 60 : 1_440))),
    writer: raw.writer === "manual" ? "manual" : "ai",
    message: String(raw.message || "").trim().slice(0, MAX_MESSAGE_CHARS),
    instruction: String(raw.instruction || "").trim().slice(0, 500),
  };
}

export function normalizeFollowUpSettings(value: unknown): FollowUpSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const steps = Array.isArray(raw.warmSteps)
    ? raw.warmSteps.slice(0, MAX_STEPS).map(normalizeStep)
    : DEFAULT_SETTINGS.warmSteps.map((step) => ({ ...step }));
  const sendStart = normalizeClock(raw.sendStart, DEFAULT_SETTINGS.sendStart);
  let sendEnd = normalizeClock(raw.sendEnd, DEFAULT_SETTINGS.sendEnd);
  if (sendStart >= sendEnd) sendEnd = DEFAULT_SETTINGS.sendEnd;

  return {
    warmEnabled: normalizeBoolean(raw.warmEnabled, false),
    warmSteps: steps.length ? steps : DEFAULT_SETTINGS.warmSteps.map((step) => ({ ...step })),
    stalledEnabled: normalizeBoolean(raw.stalledEnabled, false),
    stalledAfterDays: Math.max(1, Math.min(365, toSafeInt(raw.stalledAfterDays, 7))),
    dailyLimit: Math.max(1, Math.min(20, toSafeInt(raw.dailyLimit, 20))),
    repeatAfterDays: Math.max(1, Math.min(365, toSafeInt(raw.repeatAfterDays, 30))),
    maxRevisits: Math.max(1, Math.min(3, toSafeInt(raw.maxRevisits, 3))),
    sendStart,
    sendEnd,
    preferredSession: String(raw.preferredSession || "").trim().slice(0, 255),
  };
}

async function getLastInboundActivity(userId: number, phone: string): Promise<number> {
  const row = await getDB().get<{ last_inbound_at: number | string | null }>(
    `SELECT last_inbound_at FROM follow_up_contact_activity
     WHERE user_id = ? AND phone = ? LIMIT 1`,
    [userId, normalizePhone(phone)]
  );
  return toSafeInt(row?.last_inbound_at);
}

function parseSettings(raw: unknown): FollowUpSettings {
  if (!raw) return normalizeFollowUpSettings(DEFAULT_SETTINGS);
  try {
    return normalizeFollowUpSettings(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return normalizeFollowUpSettings(DEFAULT_SETTINGS);
  }
}

function hydrateItem(row: ItemRow): FollowUpItem {
  return {
    id: toSafeInt(row.id),
    userId: toSafeInt(row.user_id),
    crmId: row.crm_id == null ? null : toSafeInt(row.crm_id),
    sessionName: String(row.session_name || ""),
    chatId: String(row.chat_id || ""),
    contactName: String(row.contact_name || "Contato"),
    contactPhone: normalizePhone(row.contact_phone),
    kind: row.kind === "stalled" ? "stalled" : "warm",
    stepIndex: toSafeInt(row.step_index),
    status: row.status,
    dueAt: toTimestamp(row.due_at),
    draftMessage: String(row.draft_message || ""),
    attemptCount: toSafeInt(row.attempt_count),
    lastError: String(row.last_error || ""),
    sentAt: toTimestamp(row.sent_at),
    sourceActivityAt: toSafeInt(row.source_activity_at),
    createdAt: toSafeInt(row.created_at),
  };
}

export async function getFollowUpSettings(userId: number): Promise<FollowUpSettings> {
  const db = getDB();
  const now = Date.now();
  await db.run(
    `INSERT INTO follow_up_settings (user_id, config, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [userId, JSON.stringify(DEFAULT_SETTINGS), now, now]
  );
  const row = await db.get<SettingsRow>(
    `SELECT config FROM follow_up_settings WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  return parseSettings(row?.config);
}

export async function saveFollowUpSettings(
  userId: number,
  rawSettings: unknown
): Promise<FollowUpSettings> {
  const raw = rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
    ? rawSettings as Record<string, unknown>
    : {};
  const requestedStart = normalizeClock(raw.sendStart, DEFAULT_SETTINGS.sendStart);
  const requestedEnd = normalizeClock(raw.sendEnd, DEFAULT_SETTINGS.sendEnd);
  if (requestedStart >= requestedEnd) {
    throw new Error("O fim da janela precisa ser depois do início.");
  }
  const settings = normalizeFollowUpSettings(raw);
  if (settings.warmEnabled) {
    for (const [index, step] of settings.warmSteps.entries()) {
      if (step.writer === "manual" && !step.message) {
        throw new Error(`Informe o texto manual da mensagem ${index + 1}.`);
      }
    }
  }

  const db = getDB();
  const now = Date.now();
  await db.run(
    `INSERT INTO follow_up_settings (user_id, config, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE config = VALUES(config), updated_at = VALUES(updated_at)`,
    [userId, JSON.stringify(settings), now, now]
  );

  if (!settings.warmEnabled) {
    await db.run(
      `UPDATE follow_up_items
       SET status = 'cancelled', due_at = NULL, updated_at = ?
       WHERE user_id = ? AND kind = 'warm'
         AND status IN ('pending', 'processing')`,
      [now, userId]
    );
  }
  if (!settings.stalledEnabled) {
    await db.run(
      `UPDATE follow_up_items
       SET status = 'cancelled', due_at = NULL, updated_at = ?
       WHERE user_id = ? AND kind = 'stalled'
         AND status IN ('pending', 'processing', 'awaiting_approval')`,
      [now, userId]
    );
  }

  return settings;
}

export async function cancelFollowUpsForInboundMessage(params: {
  userId: number;
  phone: string;
}): Promise<number> {
  const userId = toSafeInt(params.userId);
  const phone = normalizePhone(params.phone);
  if (!userId || !phone) return 0;

  const db = getDB();
  const now = Date.now();
  await db.run(
    `INSERT INTO follow_up_contact_activity (user_id, phone, last_inbound_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_inbound_at = GREATEST(last_inbound_at, VALUES(last_inbound_at)),
       updated_at = VALUES(updated_at)`,
    [userId, phone, now, now]
  );

  const result = await db.run(
    `UPDATE follow_up_items
     SET status = 'cancelled', due_at = NULL, updated_at = ?
     WHERE user_id = ? AND contact_phone = ?
       AND status IN ('pending', 'processing', 'awaiting_approval')`,
    [now, userId, phone]
  );
  return Number(result.affectedRows || 0);
}

export async function scheduleWarmFollowUp(params: {
  userId: number;
  sessionName: string;
  chatId: string;
  contactName: string;
  contactPhone: string;
  sourceActivityAt?: number;
}): Promise<void> {
  const userId = toSafeInt(params.userId);
  const sessionName = String(params.sessionName || "").trim().slice(0, 255);
  const chatId = String(params.chatId || "").trim().slice(0, 255);
  const phone = normalizePhone(params.contactPhone);
  if (!userId || !sessionName || !chatId || !phone) return;
  if (/@(?:g\.us|broadcast)$/i.test(chatId)) return;

  const settings = await getFollowUpSettings(userId);
  if (!settings.warmEnabled || !settings.warmSteps.length) return;

  const db = getDB();
  const sourceActivityAt = toSafeInt(params.sourceActivityAt, Date.now()) || Date.now();
  if (await getLastInboundActivity(userId, phone) > sourceActivityAt) return;
  const crm = await db.get<{ id: number; name: string | null }>(
    `SELECT id, name FROM crm WHERE user_id = ? AND phone = ? LIMIT 1`,
    [userId, phone]
  );
  const now = Date.now();
  await db.run(
    `UPDATE follow_up_items
     SET status = 'cancelled', due_at = NULL, updated_at = ?
     WHERE user_id = ? AND contact_phone = ? AND kind = 'warm'
       AND status IN ('pending', 'processing')`,
    [now, userId, phone]
  );

  const step = settings.warmSteps[0];
  const result = await db.run(
    `INSERT INTO follow_up_items (
       user_id, crm_id, session_name, chat_id, contact_name, contact_phone,
       kind, step_index, source_activity_at, cycle_id, status, due_at, draft_message,
       attempt_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'warm', 0, ?, ?, 'pending', ?, ?, 0, ?, ?)`,
    [
      userId,
      crm?.id ?? null,
      sessionName,
      chatId,
      String(params.contactName || crm?.name || "Contato").slice(0, 255),
      phone,
      sourceActivityAt,
      sourceActivityAt,
      Math.max(now, sourceActivityAt + step.afterMinutes * MINUTE_MS),
      step.message || null,
      now,
      now,
    ]
  );
  const itemId = toSafeInt((result as any)?.insertId);
  if (!itemId) return;
  if (await getLastInboundActivity(userId, phone) > sourceActivityAt) {
    await db.run(
      `UPDATE follow_up_items SET status = 'cancelled', due_at = NULL, updated_at = ?
       WHERE id = ? AND user_id = ? AND status IN ('pending', 'processing')`,
      [Date.now(), itemId, userId]
    );
  }
}

async function loadSessionPrompt(userId: number, sessionName: string): Promise<string> {
  const row = await getDB().get<{
    prompt: string | null;
    ai_config: string | null;
    session_ai_config: string | null;
  }>(
    `SELECT u.prompt, u.ai_config, s.ai_config AS session_ai_config
     FROM users u
     LEFT JOIN sessions s ON s.user_id = u.id AND s.session_name = ?
     WHERE u.id = ?
     LIMIT 1`,
    [sessionName, userId]
  );
  return resolveAiPrompt({
    sessionConfig: row?.session_ai_config,
    accountConfig: row?.ai_config,
    legacyPrompt: row?.prompt,
  });
}

export async function generateFollowUpMessage(params: {
  userId: number;
  sessionName: string;
  chatId: string;
  instruction?: string | null;
  contactName?: string | null;
}): Promise<string> {
  if (!(await canUseIA(params.userId))) {
    throw new Error("O limite de mensagens com IA foi atingido. Use um texto manual ou ajuste seu plano.");
  }

  const basePrompt = await loadSessionPrompt(params.userId, params.sessionName);
  const followUpPrompt = [
    basePrompt,
    "TAREFA: escreva uma única mensagem curta de follow-up para retomar esta conversa do WhatsApp.",
    "Use o histórico recente e o contexto da empresa. Não responda como se o cliente tivesse acabado de mandar uma mensagem.",
    "Seja cordial, natural e sem pressão. Não invente fatos, descontos, prazos ou promessas.",
    "Não mencione que a mensagem foi escrita por IA. Retorne somente o texto que será enviado.",
    String(params.instruction || "").trim(),
  ].filter(Boolean).join("\n\n");

  const result = await generateAIResponse({
    aiSelected: resolveRuntimeAiProvider(process.env.AI_SELECTED),
    prompt: followUpPrompt,
    buffer: [
      `Escreva uma mensagem de follow-up para ${String(params.contactName || "o cliente").slice(0, 120)}.`,
    ],
    userId: params.userId,
    sessionName: params.sessionName,
    chatId: params.chatId,
  });

  const message = String(result || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new Error("A IA não conseguiu preparar a mensagem de follow-up.");
  await consumeIaMessage(params.userId);
  return message;
}

export async function listStalledLeads(params: {
  userId: number;
  limit?: number;
}): Promise<StalledLead[]> {
  const userId = toSafeInt(params.userId);
  const limit = Math.max(1, Math.min(100, toSafeInt(params.limit, 50)));
  const settings = await getFollowUpSettings(userId);
  if (!settings.stalledEnabled) return [];
  const cutoff = Date.now() - settings.stalledAfterDays * DAY_MS;
  const db = getDB();
  const rows = await db.all<{
    id: number;
    name: string;
    phone: string;
    stage: string | null;
    last_seen: number | string | null;
    deal_value: number | string | null;
    sent_count: number | string | null;
    last_sent_at: number | string | null;
  }>(
    `SELECT c.id, c.name, c.phone, c.stage, c.last_seen, c.deal_value,
       (SELECT COUNT(*) FROM follow_up_items f
        WHERE f.user_id = c.user_id AND f.crm_id = c.id
          AND f.kind = 'stalled' AND f.status = 'sent') AS sent_count,
       (SELECT MAX(sent_at) FROM follow_up_items f
        WHERE f.user_id = c.user_id AND f.crm_id = c.id
          AND f.kind = 'stalled' AND f.status = 'sent') AS last_sent_at
     FROM crm c
     WHERE c.user_id = ? AND c.last_seen IS NOT NULL AND c.last_seen <= ?
       AND LOWER(TRIM(COALESCE(c.stage, ''))) NOT IN ('fechado', 'perdido')
       AND NOT EXISTS (
         SELECT 1 FROM follow_up_items active
         WHERE active.user_id = c.user_id AND active.crm_id = c.id
           AND active.kind = 'stalled'
           AND active.status IN ('awaiting_approval', 'pending', 'processing')
       )
     ORDER BY COALESCE(c.deal_value, 0) DESC, c.last_seen ASC, c.id ASC
     LIMIT ?`,
    [userId, cutoff, Math.min(1_000, limit * 10)]
  );

  const suppressionRows = await db.all<{ phone: string }>(
    `SELECT phone FROM dispatch_suppressions WHERE user_id = ? AND status = 'active'`,
    [userId]
  );
  const suppressed = new Set(suppressionRows.map((row) => normalizePhone(row.phone)));
  const recentActivityRows = await db.all<{ phone: string; last_inbound_at: number | string }>(
    `SELECT phone, last_inbound_at FROM follow_up_contact_activity
     WHERE user_id = ? AND last_inbound_at > ?`,
    [userId, cutoff]
  );
  const recentActivityByPhone = new Map<string, number>();
  for (const row of recentActivityRows) {
    recentActivityByPhone.set(normalizePhone(row.phone), toSafeInt(row.last_inbound_at));
  }
  const now = Date.now();

  return rows
    .map((row) => ({
      crmId: toSafeInt(row.id),
      name: String(row.name || "Contato"),
      phone: normalizePhone(row.phone),
      stage: String(row.stage || "Novo"),
      lastSeenAt: Math.max(
        toSafeInt(row.last_seen),
        recentActivityByPhone.get(normalizePhone(row.phone)) || 0
      ),
      dealValue: Number(row.deal_value || 0),
      sentCount: toSafeInt(row.sent_count),
      lastSentAt: toTimestamp(row.last_sent_at),
    }))
    .filter((lead) =>
      lead.phone &&
      lead.lastSeenAt <= cutoff &&
      !suppressed.has(lead.phone) &&
      !["fechado", "perdido"].includes(normalizeStage(lead.stage)) &&
      lead.sentCount < settings.maxRevisits &&
      (!lead.lastSentAt || lead.lastSentAt <= now - settings.repeatAfterDays * DAY_MS)
    )
    .slice(0, limit);
}

export async function prepareStalledLeadDraft(params: {
  userId: number;
  crmId: number;
  instruction?: string | null;
}): Promise<FollowUpItem> {
  const userId = toSafeInt(params.userId);
  const crmId = toSafeInt(params.crmId);
  const settings = await getFollowUpSettings(userId);
  if (!settings.stalledEnabled) {
    throw new Error("Ative o reengajamento de leads parados antes de preparar mensagens.");
  }

  const db = getDB();
  const lead = await db.get<{
    id: number;
    name: string;
    phone: string;
    stage: string | null;
    last_seen: number | string | null;
    deal_value: number | string | null;
  }>(
    `SELECT id, name, phone, stage, last_seen, deal_value
     FROM crm WHERE id = ? AND user_id = ? LIMIT 1`,
    [crmId, userId]
  );
  const phone = normalizePhone(lead?.phone);
  const lastSeenAt = Math.max(
    toSafeInt(lead?.last_seen),
    phone ? await getLastInboundActivity(userId, phone) : 0
  );
  if (!lead || !phone || !lastSeenAt || lastSeenAt > Date.now() - settings.stalledAfterDays * DAY_MS) {
    throw new Error("Este contato ainda não está elegível para follow-up.");
  }
  if (["fechado", "perdido"].includes(normalizeStage(lead.stage))) {
    throw new Error("Contatos fechados ou perdidos não entram no reengajamento.");
  }

  const suppression = await db.get<{ id: number }>(
    `SELECT id FROM dispatch_suppressions
     WHERE user_id = ? AND phone = ? AND status = 'active' LIMIT 1`,
    [userId, phone]
  );
  if (suppression) throw new Error("Este número pediu para não receber envios automáticos.");

  const prior = await db.get<{ sent_count: number | string | null; last_sent_at: number | string | null }>(
    `SELECT COUNT(*) AS sent_count, MAX(sent_at) AS last_sent_at
     FROM follow_up_items
     WHERE user_id = ? AND crm_id = ? AND kind = 'stalled' AND status = 'sent'`,
    [userId, crmId]
  );
  const sentCount = toSafeInt(prior?.sent_count);
  const lastSentAt = toTimestamp(prior?.last_sent_at);
  if (sentCount >= settings.maxRevisits || (lastSentAt && lastSentAt > Date.now() - settings.repeatAfterDays * DAY_MS)) {
    throw new Error("Este contato ainda está no intervalo de segurança entre reengajamentos.");
  }

  const active = await db.get<{ id: number }>(
    `SELECT id FROM follow_up_items
     WHERE user_id = ? AND crm_id = ? AND kind = 'stalled'
       AND status IN ('awaiting_approval', 'pending', 'processing')
     LIMIT 1`,
    [userId, crmId]
  );
  if (active) throw new Error("Já existe um follow-up em andamento para este contato.");

  let sessionName = settings.preferredSession;
  if (sessionName) {
    const preferred = await db.get<{ session_name: string }>(
      `SELECT session_name FROM sessions
       WHERE user_id = ? AND session_name = ? AND status = 'connected' LIMIT 1`,
      [userId, sessionName]
    );
    if (!preferred) sessionName = "";
  }
  if (!sessionName) {
    const session = await db.get<{ session_name: string }>(
      `SELECT session_name FROM sessions
       WHERE user_id = ? AND status = 'connected'
       ORDER BY (session_name = (SELECT default_session_name FROM users WHERE id = ?)) DESC,
         created_at DESC, id DESC LIMIT 1`,
      [userId, userId]
    );
    sessionName = String(session?.session_name || "");
  }
  if (!sessionName) throw new Error("Conecte uma sessão do WhatsApp para preparar o follow-up.");

  const chatId = `${phone}@c.us`;
  const draftMessage = await generateFollowUpMessage({
    userId,
    sessionName,
    chatId,
    contactName: lead.name,
    instruction: params.instruction,
  });
  const latestActivity = await db.get<{ last_seen: number | string | null }>(
    `SELECT last_seen FROM crm WHERE id = ? AND user_id = ? LIMIT 1`,
    [crmId, userId]
  );
  if (toSafeInt(latestActivity?.last_seen) > lastSeenAt) {
    throw new Error("O contato voltou a conversar enquanto a mensagem era preparada.");
  }
  if (await getLastInboundActivity(userId, phone) > lastSeenAt) {
    throw new Error("O contato voltou a conversar enquanto a mensagem era preparada.");
  }
  const now = Date.now();
  const result = await db.run(
    `INSERT INTO follow_up_items (
       user_id, crm_id, session_name, chat_id, contact_name, contact_phone,
       kind, step_index, source_activity_at, cycle_id, status, due_at, draft_message,
       attempt_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'stalled', 0, ?, ?, 'awaiting_approval', NULL, ?, 0, ?, ?)`,
    [userId, crmId, sessionName, chatId, lead.name, phone, lastSeenAt, now, draftMessage, now, now]
  );
  const id = toSafeInt((result as any)?.insertId);
  const item = await db.get<ItemRow>(`SELECT * FROM follow_up_items WHERE id = ? AND user_id = ?`, [id, userId]);
  if (!item) throw new Error("Não foi possível salvar o rascunho de follow-up.");
  if (await getLastInboundActivity(userId, phone) > lastSeenAt) {
    await db.run(
      `UPDATE follow_up_items
       SET status = 'cancelled', last_error = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'awaiting_approval'`,
      ["O contato voltou a conversar enquanto a mensagem era preparada.", Date.now(), id, userId]
    );
    const cancelled = await db.get<ItemRow>(`SELECT * FROM follow_up_items WHERE id = ? AND user_id = ?`, [id, userId]);
    if (cancelled) return hydrateItem(cancelled);
  }
  return hydrateItem(item);
}

export async function listFollowUpItems(params: {
  userId: number;
  tab?: "scheduled" | "results";
  limit?: number;
}): Promise<FollowUpItem[]> {
  const userId = toSafeInt(params.userId);
  const limit = Math.max(1, Math.min(100, toSafeInt(params.limit, 50)));
  const statuses = params.tab === "results"
    ? ["sent", "failed", "cancelled", "skipped"]
    : ["pending", "processing", "awaiting_approval"];
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = await getDB().all<ItemRow>(
    `SELECT * FROM follow_up_items
     WHERE user_id = ? AND status IN (${placeholders})
     ORDER BY COALESCE(due_at, updated_at) ASC, id DESC
     LIMIT ?`,
    [userId, ...statuses, limit]
  );
  return rows.map(hydrateItem);
}

export async function approveStalledFollowUp(params: {
  userId: number;
  itemId: number;
}): Promise<void> {
  const userId = toSafeInt(params.userId);
  const itemId = toSafeInt(params.itemId);
  const settings = await getFollowUpSettings(userId);
  if (!settings.stalledEnabled) throw new Error("Ative o reengajamento antes de aprovar envios.");

  const result = await getDB().run(
    `UPDATE follow_up_items
     SET status = 'pending', due_at = ?, last_error = NULL, updated_at = ?
     WHERE id = ? AND user_id = ? AND kind = 'stalled'
       AND status = 'awaiting_approval'`,
    [Date.now(), Date.now(), itemId, userId]
  );
  if (!result.affectedRows) throw new Error("Rascunho não encontrado ou já processado.");
}

export async function updateFollowUpDraft(params: {
  userId: number;
  itemId: number;
  message: string;
}): Promise<void> {
  const message = String(params.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new Error("Escreva a mensagem antes de salvar.");
  const result = await getDB().run(
    `UPDATE follow_up_items
     SET draft_message = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND kind = 'stalled'
       AND status = 'awaiting_approval'`,
    [message, Date.now(), toSafeInt(params.itemId), toSafeInt(params.userId)]
  );
  if (!result.affectedRows) throw new Error("Só é possível editar rascunhos aguardando aprovação.");
}

export async function cancelFollowUpItem(params: {
  userId: number;
  itemId: number;
}): Promise<void> {
  const result = await getDB().run(
    `UPDATE follow_up_items
     SET status = 'cancelled', due_at = NULL, updated_at = ?
     WHERE id = ? AND user_id = ?
       AND status IN ('pending', 'processing', 'awaiting_approval')`,
    [Date.now(), toSafeInt(params.itemId), toSafeInt(params.userId)]
  );
  if (!result.affectedRows) throw new Error("Follow-up não encontrado ou já finalizado.");
}

export async function scheduleNextWarmFollowUp(params: {
  userId: number;
  crmId: number | null;
  sourceActivityAt: number;
  afterStepIndex: number;
  sessionName: string;
  chatId: string;
  contactName: string;
  contactPhone: string;
}): Promise<void> {
  const userId = toSafeInt(params.userId);
  const settings = await getFollowUpSettings(userId);
  const nextIndex = toSafeInt(params.afterStepIndex) + 1;
  const step = settings.warmSteps[nextIndex];
  if (!settings.warmEnabled || !step) return;

  const db = getDB();
  if (await getLastInboundActivity(userId, params.contactPhone) > params.sourceActivityAt) return;
  const now = Date.now();
  await db.run(
    `INSERT INTO follow_up_items (
       user_id, crm_id, session_name, chat_id, contact_name, contact_phone,
       kind, step_index, source_activity_at, cycle_id, status, due_at, draft_message,
       attempt_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'warm', ?, ?, ?, 'pending', ?, ?, 0, ?, ?)
     ON DUPLICATE KEY UPDATE status = 'pending', due_at = VALUES(due_at),
       draft_message = VALUES(draft_message), last_error = NULL, updated_at = VALUES(updated_at)`,
    [
      userId,
      params.crmId,
      params.sessionName,
      params.chatId,
      params.contactName,
      normalizePhone(params.contactPhone),
      nextIndex,
      params.sourceActivityAt,
      params.sourceActivityAt,
      now + step.afterMinutes * MINUTE_MS,
      step.message || null,
      now,
      now,
    ]
  );
  if (await getLastInboundActivity(userId, params.contactPhone) > params.sourceActivityAt) {
    await db.run(
      `UPDATE follow_up_items SET status = 'cancelled', due_at = NULL, updated_at = ?
       WHERE user_id = ? AND contact_phone = ? AND kind = 'warm'
         AND cycle_id = ? AND step_index = ? AND status IN ('pending', 'processing')`,
      [Date.now(), userId, normalizePhone(params.contactPhone), params.sourceActivityAt, nextIndex]
    );
  }
}

export async function getFollowUpItemById(id: number): Promise<FollowUpItem | null> {
  const row = await getDB().get<ItemRow>(`SELECT * FROM follow_up_items WHERE id = ? LIMIT 1`, [id]);
  return row ? hydrateItem(row) : null;
}

export async function markFollowUpItem(
  id: number,
  status: FollowUpItemStatus,
  params: { dueAt?: number | null; error?: string | null; sentAt?: number | null } = {}
): Promise<void> {
  await getDB().run(
    `UPDATE follow_up_items
     SET status = ?, due_at = ?, last_error = ?, sent_at = ?, updated_at = ?
     WHERE id = ?`,
    [status, params.dueAt ?? null, params.error ?? null, params.sentAt ?? null, Date.now(), id]
  );
}

export async function addFollowUpAttempt(id: number, error: string): Promise<void> {
  await getDB().run(
    `UPDATE follow_up_items
     SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
     WHERE id = ?`,
    [String(error || "Falha ao enviar").slice(0, 1_000), Date.now(), id]
  );
}

export async function loadFollowUpSettingsForUser(userId: number): Promise<FollowUpSettings> {
  return getFollowUpSettings(userId);
}

export function getNextFollowUpWindowTimestamp(
  timestamp: number,
  timezoneOffsetMinutes: number,
  start: string,
  end: string
): number {
  const offset = Number.isFinite(timezoneOffsetMinutes) ? timezoneOffsetMinutes : -180;
  const local = new Date(timestamp + offset * MINUTE_MS);
  const startParts = start.split(":").map(Number);
  const endParts = end.split(":").map(Number);
  const startMinute = startParts[0] * 60 + startParts[1];
  const endMinute = endParts[0] * 60 + endParts[1];
  const nowMinute = local.getUTCHours() * 60 + local.getUTCMinutes();

  if (nowMinute >= startMinute && nowMinute < endMinute) return timestamp;

  const nextLocal = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    Math.floor(startMinute / 60),
    startMinute % 60,
    0,
    0
  ));
  if (nowMinute >= endMinute) nextLocal.setUTCDate(nextLocal.getUTCDate() + 1);
  return nextLocal.getTime() - offset * MINUTE_MS;
}

export const FOLLOW_UP_DAY_MS = DAY_MS;
