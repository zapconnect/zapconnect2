// ===============================
//  WPP MANAGER MULTI-SESSÃO COMPLETO + STATUS EM TEMPO REAL
// ===============================
import wppconnect from "@wppconnect-team/wppconnect";
import terminalKit from "terminal-kit";
import qrcode from "qrcode";
import axios from "axios";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { SpeechClient } from "@google-cloud/speech";
import { getDB } from "./database";
import { splitMessages, sendMessagesWithDelay } from "./util";
import { emitToUser } from "./lib/socketEmitter";
import { canUseIA, consumeIaMessage } from "./services/iaLimiter";
import { assertValidPhone, buildWhatsAppJid, sanitizePhone, validatePhone } from "./utils/phoneUtils";
import { withTimeout } from "./utils/withTimeout";
import { deliverWebhook } from "./utils/webhookDelivery";
import {
  checkFallbackTriggers,
  clearFallbackRuntime,
  primeFallbackCache,
  markFallbackTimestamp,
  type FallbackDecision,
  type FallbackReason,
} from "./services/fallbackService";
import { generateAIResponse } from "./services/aiHandler";
import { getChatAI } from "./services/chatAiService";
import { isInSilenceWindow } from "./services/silenceUtils";
import {
  clearDispatchSuppression,
  detectDispatchConsentCommand,
  upsertDispatchSuppression,
} from "./services/dispatchPolicy";
import { logAudit } from "./utils/audit";





function clearChromiumLocks(sessionDir: string) {
  const lockFiles = [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
  ];

  lockFiles.forEach((file) => {
    const filePath = path.join(sessionDir, file);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(" Lock removido:", file);
      } catch { }
    }
  });
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
/**
 * Compatível com versões antigas do WPPConnect
 * Não tenta forçar LID manualmente
 */
const NUMBER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const numberValidationCache = new Map<string, number>(); // jid -> timestamp
type NumberStatusCheckResult = { canReceiveMessage?: boolean } | null;

export async function ensureChat(
  client: any,
  number: string
): Promise<string> {
  const sanitized = assertValidPhone(number, "destinatário");
  const jid = buildWhatsAppJid(sanitized);

  const cachedTs = numberValidationCache.get(jid);
  if (cachedTs && Date.now() - cachedTs < NUMBER_CACHE_TTL_MS) {
    return jid;
  }

  // Se já temos CRM/IA cache, assumimos válido para quem já interagiu
  // (chaves no formato USER{userId}_{chatId})
  const seenInChat = Array.from(chatActivity.keys()).some((key) =>
    key.endsWith(`::${jid}`)
  );
  if (seenInChat) {
    numberValidationCache.set(jid, Date.now());
    return jid;
  }

  const exists = await withTimeout<NumberStatusCheckResult>(
    client.checkNumberStatus(jid),
    WPP_TIMEOUT_MS,
    "checkNumberStatus"
  );
  if (!exists?.canReceiveMessage) {
    throw new Error("Número inválido ou não registrado no WhatsApp");
  }

  numberValidationCache.set(jid, Date.now());
  // ✅ Retorna sempre JID completo para consistência de chaves (@c.us)
  return jid;
}

type FlowConditions = {
  stage?: string;
  tags?: string[];
  hours?: { start: number; end: number };
  firstMessageOnly?: boolean;
};

type FlowContext = {
  userId: number;
  sessionName: string;
  chatId: string;
  messageBody: string;
  client: any;
  crm?: { stage?: string | null; tags?: string[] };
  localHour?: number;
  isFirstMessage: boolean;
  contactName?: string;
  phone?: string;
  localDateStr?: string;
  localTimeStr?: string;
  lastResponse?: string;
  isNewContact?: boolean;
};

type BranchCondition = {
  contains?: string | string[];
};

function matchFlowConditions(conditions: FlowConditions | null, ctx: FlowContext): boolean {
  if (!conditions) return true;

  if (conditions.stage) {
    const stage = ctx.crm?.stage || "";
    if (stage.toLowerCase() !== conditions.stage.toLowerCase()) return false;
  }

  if (conditions.tags && conditions.tags.length) {
    const tags = ctx.crm?.tags || [];
    const norm = tags.map((t) => (t || "").toLowerCase());
    const req = conditions.tags.map((t) => (t || "").toLowerCase());
    if (!req.every((t) => norm.includes(t))) return false;
  }

  if (conditions.hours && typeof ctx.localHour === "number") {
    const { start, end } = conditions.hours;
    const h = ctx.localHour;
    const ok = start <= end ? h >= start && h < end : h >= start || h < end;
    if (!ok) return false;
  }

  if (conditions.firstMessageOnly && !ctx.isFirstMessage) return false;

  return true;
}

// ... dentro do mesmo arquivo:
async function executeUserFlows(ctx: FlowContext) {
  try {
    const db = await getDB();
    const rows = await db.all(`SELECT * FROM flows WHERE user_id = ?`, [ctx.userId]);
    if (!rows || !rows.length) return;

    const matched = rows.filter((r) => {
      if (r.active === 0 || r.active === false) return false;
      let triggers: string[] = [];
      try {
        if (r.triggers) triggers = JSON.parse(r.triggers);
      } catch { }
      if (!Array.isArray(triggers) || !triggers.length) {
        const legacy = (r.trigger || r.trigger_type || "").trim();
        if (legacy) triggers = [legacy];
      }
      const lower = ctx.messageBody.toLowerCase();
      return triggers.some((t) => t && lower.includes(String(t).toLowerCase()));
    });

    if (!matched.length) return;

    // Ordena por prioridade (desc) e, em caso de empate, pelo id (asc) para determinismo
    const best = matched
      .sort((a, b) => (Number(b.priority || 0) - Number(a.priority || 0)) || (a.id - b.id))[0];

    let conditions: FlowConditions | null = null;
    try {
      conditions = best.conditions ? JSON.parse(best.conditions) : null;
    } catch { }

    if (!matchFlowConditions(conditions, ctx)) return;

    const actions = JSON.parse(best.actions || "[]");
    await runFlowActions(actions, ctx);
  } catch (err) {
    console.error("Erro executar flows:", err);
  }
}

async function executeWelcomeFlow(
  ctx: FlowContext & { isNewContact: boolean }
) {
  if (!ctx.isNewContact) return;

  try {
    const db = await getDB();
    const flow = await db.get<any>(
      `SELECT * FROM welcome_flows WHERE user_id = ? AND active = 1 LIMIT 1`,
      [ctx.userId]
    );
    if (!flow) return;

    const actions = JSON.parse(flow.actions || "[]");
    if (!Array.isArray(actions) || !actions.length) return;

    await runFlowActions(actions, ctx);
  } catch (err) {
    console.error("Erro executar fluxo de boas-vindas:", err);
  }
}



// ===========================
// FUNÇÃO DE SALVAR/ATUALIZAR CLIENTE AUTOMATICAMENTE NO CRM
// ===========================
async function saveCRMClient(
  userId: number,
  sessionName: string,
  msg: any
): Promise<{ isNew: boolean; crmId?: number; crmData?: { stage?: string | null; tags?: string[] } }> {
  try {
    const db = await getDB();
    const chatId = msg.chatId?.toString();
    if (!chatId || msg.isGroupMsg) return { isNew: false };

    // valida userId numérico e sessão pertencente ao usuário
    if (!Number.isFinite(userId)) return { isNew: false };
    const ownsSession = await db.get(
      `SELECT 1 FROM sessions WHERE user_id = ? AND session_name = ? LIMIT 1`,
      [userId, sessionName]
    );
    if (!ownsSession) return { isNew: false };

    const phone = chatId.replace("@c.us", "");
    const name =
      msg.sender?.pushname ||
      msg.sender?.name ||
      msg.sender?.shortName ||
      phone;

    const avatar = msg.sender?.profilePicThumbObj?.eurl || null;
    const lastSeen = Date.now();
    const cacheKey = `USER${userId}_${phone}`;

    // Verifica se o cliente já existe para ESTE userId e ESTE telefone
    const existing = await db.get<{ id: number; stage: string | null; tags: string | null }>(
      `SELECT id, stage, tags FROM crm WHERE user_id = ? AND phone = ?`,
      [userId, phone]
    );

    if (existing) {
      const cached = crmWriteCache.get(cacheKey);
      const withinTtl = cached && lastSeen - cached.lastWrite < CRM_UPDATE_TTL_MS;
      const sameName = cached ? cached.name === name : false;
      const sameAvatar = cached ? cached.avatar === avatar : false;

      // Só grava se mudou algo relevante ou se TTL expirou
      if (!withinTtl || !sameName || !sameAvatar) {
        await db.run(
          `UPDATE crm 
           SET name = ?, avatar = ?, last_seen = ?
           WHERE id = ?`,
          [name, avatar, lastSeen, existing.id]
        );
        crmWriteCache.set(cacheKey, { name, avatar, lastWrite: lastSeen });
      }

      let parsedTags: string[] = [];
      try { parsedTags = existing.tags ? JSON.parse(existing.tags) : []; } catch { }
      return {
        isNew: false,
        crmId: existing.id,
        crmData: {
          stage: existing.stage ?? null,
          tags: parsedTags,
        },
      };
    } else {
      // Cria cliente novo incluindo user_id
      const result = await db.run(
        `INSERT INTO crm (user_id, name, phone, citystate, stage, tags, notes, avatar, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          name,
          phone,
          "",        // citystate
          "Novo",    // stage
          "[]",      // tags
          "[]",      // notes
          avatar,
          lastSeen
        ]
      );
      crmWriteCache.set(cacheKey, { name, avatar, lastWrite: lastSeen });
      return {
        isNew: true,
        crmId: result.insertId,
        crmData: {
          stage: "Novo",
          tags: [],
        },
      };
    }
  } catch (err) {
    console.log("ALERTA Erro ao salvar cliente CRM:", err);
    return { isNew: false };
  }

  return { isNew: false };
}




// Controle de IA por chat (true = ligado, false = desligado)
// chave = USER{userId}_{chatId}
export const chatAILock = new Map<string, boolean>();
// ⏱️ Controle de humano / tempo


async function primeChatAICache(userId: number, forceReload = false) {
  const now = Date.now();
  const last = chatAICacheLoaded.get(userId);
  if (!forceReload && last && now - last < CHAT_AI_CACHE_TTL_MS) return;

  // Limpa cache existente daquele usuário antes de recarregar
  for (const key of Array.from(chatAILock.keys())) {
    if (key.startsWith(`USER${userId}_`)) {
      chatAILock.delete(key);
      chatAIActivity.delete(key);
    }
  }

  try {
    const db = await getDB();
    const rows = await db.all<{ chat_id: string; ai_enabled: number }>(
      `SELECT chat_id, ai_enabled FROM chat_ai_settings WHERE user_id = ?`,
      [userId]
    );
    for (const r of rows) {
      const key = `USER${userId}_${r.chat_id}`;
      chatAILock.set(key, r.ai_enabled === 1);
      chatAIActivity.set(key, Date.now());
    }
    chatAICacheLoaded.set(userId, now);
  } catch (err) {
    console.warn("Não foi possível carregar cache de chat AI:", err);
  }
}

async function getChatAIState(userId: number, chatId: string): Promise<boolean> {
  const last = chatAICacheLoaded.get(userId);
  const needsRefresh = !last || Date.now() - last >= CHAT_AI_CACHE_TTL_MS;
  await primeChatAICache(userId, needsRefresh);

  const key = `USER${userId}_${chatId}`;
  if (chatAILock.has(key)) {
    chatAIActivity.set(key, Date.now());
    return !!chatAILock.get(key);
  }
  const enabled = await getChatAI(userId, chatId);
  chatAILock.set(key, enabled);
  chatAIActivity.set(key, Date.now());
  return enabled;
}



const term = terminalKit.terminal;

const AI_SELECTED = (process.env.AI_SELECTED as "GPT" | "GEMINI") || "GEMINI";
const MAX_RETRIES = 3;

const clients = new Map<string, wppconnect.Whatsapp>();

// Evitar eventos duplicados
const eventsAttached = new Set<string>();
// ===========================
//  AUTO RECONNECT CONTROL
// ===========================
const reconnecting = new Set<string>();
const reconnectAttempts = new Map<string, number>();
type ReconnectCircuitState = {
  openedAt: number;
  attempts: number;
  reason: string;
};
type SessionStartSource =
  | "manual_create"
  | "manual_restart"
  | "auto_reconnect"
  | "startup_restore";
type CreateWppSessionOptions = {
  source?: SessionStartSource;
};
const reconnectCircuitOpen = new Map<string, ReconnectCircuitState>();
const RECONNECT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.WPP_RECONNECT_MAX_ATTEMPTS || 6)
);
const RECONNECT_STATUS_CIRCUIT_OPEN = "circuit_open";
const BANNED_SESSION_STATUS = "banned";
const REAUTH_REQUIRED_SESSION_STATUS = "reauth_required";
const bannedSessions = new Set<string>();
const BAN_INDICATORS = [
  "banned",
  "unauthorized",
  "forbidden",
  "your account has been",
  "invalid session",
  "401",
  "403",
];
const BAN_PROBE_STATES = ["disconnectedmobile", "serverclose", "logout"];
const BANNED_SESSION_USER_MESSAGE =
  "Possivel banimento detectado nesta sessao. Nao tente reconectar imediatamente. Aguarde e procure o suporte antes de autenticar de novo.";
const REAUTH_REQUIRED_SESSION_USER_MESSAGE =
  "A sessao precisa de autenticacao manual. A recuperacao automatica foi interrompida para evitar loop. Clique em reconectar quando quiser gerar um novo QR.";
let speechClient: SpeechClient | null = null;
const AUDIO_TRANSCRIBE_PROVIDER = (process.env.AUDIO_TRANSCRIBE_PROVIDER || "").toLowerCase(); // "google", "deepgram" ou vazio (desativado)
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const inboundCount = new Map<string, number>(); // chatKey -> quantidade de mensagens recebidas (para firstMessageOnly)
const chatAICacheLoaded = new Map<number, number>(); // userId -> timestamp do último preload
const sessionLocks = new Map<string, Promise<void>>(); // garante exclusão mútua por sessão para attach/reconnect
const sessionCreationPromises = new Map<
  string,
  Promise<{ sessionName: string; exists?: boolean }>
>();
const chatActivity = new Map<string, number>(); // chatKey -> last activity
const chatAIActivity = new Map<string, number>(); // aiKey -> last activity
const CRM_UPDATE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const CHAT_AI_CACHE_TTL_MS = 5 * 60 * 1000; // recarrega configurações de IA a cada 5 minutos
const crmWriteCache = new Map<string, { name: string | null; avatar: string | null; lastWrite: number }>();
const CHAT_ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CHAT_ACTIVITY_SWEEP_MS = 60 * 60 * 1000; // 1h
const WPP_TIMEOUT_MS = Number(process.env.WPP_TIMEOUT_MS || 12_000);

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const touchChatActivity = (chatKey: string, aiKey?: string) => {
  const now = Date.now();
  chatActivity.set(chatKey, now);
  if (aiKey) chatAIActivity.set(aiKey, now);
};

function withSessionLock(full: string, task: () => Promise<void> | void): Promise<void> {
  const prev = sessionLocks.get(full) || Promise.resolve();
  const next = prev
    .catch(() => {}) // evita cancelar cadeia se tarefa anterior falhou
    .then(() => task())
    .finally(() => {
      if (sessionLocks.get(full) === next) {
        sessionLocks.delete(full);
      }
    });
  sessionLocks.set(full, next);
  return next;
}

function getReconnectReason(reason: unknown) {
  if (reason instanceof Error) return reason.message || "erro desconhecido";
  if (typeof reason === "string") {
    const trimmed = reason.trim();
    return trimmed || "erro desconhecido";
  }
  if (reason == null) return "erro desconhecido";
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function hasBanIndicator(value: unknown) {
  const text = String(value || "").toLowerCase();
  return BAN_INDICATORS.some((indicator) => text.includes(indicator));
}

function isAutomaticSessionStart(source: SessionStartSource) {
  return source === "auto_reconnect" || source === "startup_restore";
}

async function detectBanSignal(client: any, state: unknown) {
  const normalizedState = String(state || "").toLowerCase().trim();

  if (hasBanIndicator(normalizedState)) {
    return {
      isBanned: true,
      reason: `estado suspeito: ${normalizedState || "desconhecido"}`,
    };
  }

  const shouldProbeHostDevice = BAN_PROBE_STATES.some((token) =>
    normalizedState.includes(token)
  );

  if (!shouldProbeHostDevice || typeof client?.getHostDevice !== "function") {
    return { isBanned: false, reason: "" };
  }

  try {
    const hostDevice = await withTimeout(
      Promise.resolve(client.getHostDevice()),
      5000,
      "getHostDevice"
    );

    if (!hostDevice) {
      return {
        isBanned: true,
        reason: `getHostDevice vazio apos ${normalizedState || "desconexao"}`,
      };
    }
  } catch (err) {
    const reason = getReconnectReason(err);
    if (hasBanIndicator(reason)) {
      return { isBanned: true, reason };
    }
  }

  return { isBanned: false, reason: "" };
}

async function probeAutoRecoveryBlock(
  client: any,
  source: SessionStartSource,
  state: unknown
) {
  const explicitBan = await detectBanSignal(client, state);
  if (explicitBan.isBanned) {
    return explicitBan;
  }

  const notes: string[] = [];

  if (typeof client?.getConnectionState === "function") {
    try {
      const connectionState = await withTimeout(
        Promise.resolve(client.getConnectionState()),
        5000,
        "getConnectionState"
      );
      const normalizedConnectionState = String(connectionState || "").trim();
      if (hasBanIndicator(normalizedConnectionState)) {
        return {
          isBanned: true,
          reason: `getConnectionState: ${normalizedConnectionState || "desconhecido"}`,
        };
      }
      if (normalizedConnectionState) {
        notes.push(`connection=${normalizedConnectionState}`);
      }
    } catch (err) {
      const reason = getReconnectReason(err);
      if (hasBanIndicator(reason)) {
        return { isBanned: true, reason: `getConnectionState: ${reason}` };
      }
      notes.push("connection=erro");
    }
  }

  if (typeof client?.isLoggedIn === "function") {
    try {
      const loggedIn = await withTimeout(
        Promise.resolve(client.isLoggedIn()),
        5000,
        "isLoggedIn"
      );
      notes.push(`isLoggedIn=${Boolean(loggedIn)}`);
    } catch (err) {
      const reason = getReconnectReason(err);
      if (hasBanIndicator(reason)) {
        return { isBanned: true, reason: `isLoggedIn: ${reason}` };
      }
      notes.push("isLoggedIn=erro");
    }
  }

  const normalizedState = String(state || "notLogged").trim() || "notLogged";
  const sourceLabel =
    source === "startup_restore" ? "restauracao automatica" : "reconexao automatica";
  const details = notes.length ? ` (${notes.join(", ")})` : "";

  return {
    isBanned: false,
    reason: `QR solicitado apos ${normalizedState} durante ${sourceLabel}${details}`,
  };
}

async function updateSessionStatus(userId: number, sessionName: string, status: string) {
  try {
    const db = await getDB();
    await db.run(
      `UPDATE sessions SET status = ? WHERE user_id = ? AND session_name = ?`,
      [status, userId, sessionName]
    );
  } catch { }
}

function resetReconnectTracking(full: string) {
  reconnectAttempts.delete(full);
  reconnectCircuitOpen.delete(full);
  bannedSessions.delete(full);
}

async function emitReconnectCircuitOpen(
  userId: number,
  sessionName: string,
  full: string,
  circuit: ReconnectCircuitState
) {
  try {
    emitToUser(userId, "session:stateChange", {
      userId,
      sessionName,
      full,
      state: RECONNECT_STATUS_CIRCUIT_OPEN,
    });
    emitToUser(userId, "session:circuitOpen", {
      userId,
      sessionName,
      full,
      attempts: circuit.attempts,
      reason: circuit.reason,
      openedAt: circuit.openedAt,
    });
    emitToUser(userId, "sessions:changed", { userId });
  } catch { }
}

async function openReconnectCircuit(
  userId: number,
  sessionName: string,
  reason: unknown,
  attempts: number
) {
  const full = `USER${userId}_${sessionName}`;
  if (reconnectCircuitOpen.has(full)) return;

  const circuit: ReconnectCircuitState = {
    openedAt: Date.now(),
    attempts,
    reason: getReconnectReason(reason),
  };

  reconnectCircuitOpen.set(full, circuit);
  await updateSessionStatus(userId, sessionName, RECONNECT_STATUS_CIRCUIT_OPEN);
  console.error(
    `🚫 Circuit breaker aberto para ${full} após ${attempts} tentativa(s): ${circuit.reason}`
  );
  await emitReconnectCircuitOpen(userId, sessionName, full, circuit);
}

async function markSessionAsBanned(
  userId: number,
  sessionName: string,
  full: string,
  state: unknown,
  reason: string,
  clientOverride?: any
) {
  if (bannedSessions.has(full)) return;

  const TOKENS_DIR = process.env.TOKENS_DIR || "tokens";
  const sessionDir = path.join(TOKENS_DIR, full);
  const normalizedReason = reason || `estado suspeito: ${String(state || "desconhecido")}`;

  resetReconnectTracking(full);
  bannedSessions.add(full);
  reconnecting.delete(full);

  await closeSessionRuntime(full, sessionDir, clientOverride);
  await updateSessionStatus(userId, sessionName, BANNED_SESSION_STATUS);

  console.warn(`⚠️ Possivel banimento detectado para ${full}: ${normalizedReason}`);

  try {
    emitToUser(userId, "session:stateChange", {
      userId,
      sessionName,
      full,
      state: BANNED_SESSION_STATUS,
      originalState: state,
      reason: normalizedReason,
    });
    emitToUser(userId, "session:banned", {
      userId,
      sessionName,
      full,
      state,
      reason: normalizedReason,
      message: BANNED_SESSION_USER_MESSAGE,
    });
    emitToUser(userId, "sessions:changed", { userId });
  } catch { }

  try {
    await logAudit("session_banned_detected", userId, "session", sessionName, {
      state: String(state || ""),
      reason: normalizedReason,
    });
  } catch { }
}

async function markSessionAsReauthRequired(
  userId: number,
  sessionName: string,
  full: string,
  state: unknown,
  reason: string,
  clientOverride?: any
) {
  const TOKENS_DIR = process.env.TOKENS_DIR || "tokens";
  const sessionDir = path.join(TOKENS_DIR, full);
  const normalizedReason =
    reason || `QR solicitado apos ${String(state || "desconhecido")}`;

  resetReconnectTracking(full);
  reconnecting.delete(full);

  await closeSessionRuntime(full, sessionDir, clientOverride);
  await updateSessionStatus(userId, sessionName, REAUTH_REQUIRED_SESSION_STATUS);

  try {
    const qrPath = getQRPathFor(full);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
  } catch { }

  console.warn(`⚠️ ${full} exige autenticacao manual: ${normalizedReason}`);

  try {
    emitToUser(userId, "session:stateChange", {
      userId,
      sessionName,
      full,
      state: REAUTH_REQUIRED_SESSION_STATUS,
      originalState: state,
      reason: normalizedReason,
    });
    emitToUser(userId, "session:reauthRequired", {
      userId,
      sessionName,
      full,
      state,
      reason: normalizedReason,
      message: REAUTH_REQUIRED_SESSION_USER_MESSAGE,
    });
    emitToUser(userId, "sessions:changed", { userId });
  } catch { }

  try {
    await logAudit("session_reauth_required", userId, "session", sessionName, {
      state: String(state || ""),
      reason: normalizedReason,
    });
  } catch { }
}

function clearInactiveChatState(chatKey: string) {
  chatActivity.delete(chatKey);
  chatHumanLock.delete(chatKey);
  chatHumanDuration.delete(chatKey);
  chatHumanLastActivity.delete(chatKey);
  pausedChats.delete(chatKey);
  inboundCount.delete(chatKey);
  messageBuffer.delete(chatKey);

  const chatHumanTimeout = chatHumanTimer.get(chatKey);
  if (chatHumanTimeout) clearTimeout(chatHumanTimeout);
  chatHumanTimer.delete(chatKey);

  const debounceTimeout = messageTimeouts.get(chatKey);
  if (debounceTimeout) clearTimeout(debounceTimeout);
  messageTimeouts.delete(chatKey);

  const humanModeTimeout = humanTimeouts.get(chatKey);
  if (humanModeTimeout) clearTimeout(humanModeTimeout);
  humanTimeouts.delete(chatKey);
}

// Limpeza periódica para evitar vazamento de memória em chats inativos
function cleanupInactiveChats() {
  const now = Date.now();
  const cutoff = now - CHAT_ACTIVITY_TTL_MS;

  for (const [key, last] of Array.from(chatActivity.entries())) {
    if (last >= cutoff) continue;
    clearInactiveChatState(key);
  }

  for (const [key, last] of Array.from(chatAIActivity.entries())) {
    if (last < cutoff) {
      chatAIActivity.delete(key);
      chatAILock.delete(key);
    }
  }

  // Expira marcação de preload de IA para permitir reload periódico
  const preloadCutoff = now - CHAT_AI_CACHE_TTL_MS;
  for (const [userId, ts] of Array.from(chatAICacheLoaded.entries())) {
    if (ts < preloadCutoff) {
      chatAICacheLoaded.delete(userId);
    }
  }

  const numberCacheCutoff = now - NUMBER_CACHE_TTL_MS;
  for (const [jid, ts] of Array.from(numberValidationCache.entries())) {
    if (ts < numberCacheCutoff) {
      numberValidationCache.delete(jid);
    }
  }

  const crmCacheCutoff = now - CRM_UPDATE_TTL_MS;
  for (const [cacheKey, entry] of Array.from(crmWriteCache.entries())) {
    if (entry.lastWrite < crmCacheCutoff) {
      crmWriteCache.delete(cacheKey);
    }
  }
}

setInterval(cleanupInactiveChats, CHAT_ACTIVITY_SWEEP_MS);

function getSpeechClientSafe(): SpeechClient | null {
  if (AUDIO_TRANSCRIBE_PROVIDER !== "google") return null;
  try {
    if (!speechClient) {
      speechClient = new SpeechClient();
    }
    return speechClient;
  } catch (err) {
    console.warn("SpeechClient não inicializado (credenciais ausentes?):", err);
    return null;
  }
}

function renderFlowTemplate(message: string, ctx: FlowContext): string {
  const phone = ctx.phone || extrairNumero(ctx.chatId);
  const name = ctx.contactName || phone;
  const tags = ctx.crm?.tags || [];
  const stage = ctx.crm?.stage || "";
  const city = (ctx.crm as any)?.citystate || "";
  const dateStr = ctx.localDateStr || new Date().toLocaleDateString("pt-BR");
  const timeStr = ctx.localTimeStr || new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  return message.replace(/{{\s*([\w.-]+)\s*}}/g, (_m, keyRaw) => {
    const key = String(keyRaw || "").toLowerCase();
    switch (key) {
      case "numero":
      case "number":
      case "phone":
        return phone;
      case "nome":
      case "name":
        return name;
      case "cidade":
      case "city":
      case "citystate":
        return city;
      case "stage":
      case "pipeline":
        return stage;
      case "tags":
        return tags.join(", ");
      case "data":
      case "data_atual":
      case "hoje":
        return dateStr;
      case "hora":
      case "horario":
      case "hora_atual":
      case "time":
        return timeStr;
      default:
        return "";
    }
  });
}

async function applyCrmUpdateFromFlow(
  payload: any,
  ctx: FlowContext
): Promise<void> {
  const phone = ctx.phone || extrairNumero(ctx.chatId);
  if (!phone) return;

  const db = await getDB();
  const row = await db.get<{ id: number; tags: string | null }>(
    `SELECT id, tags FROM crm WHERE user_id = ? AND phone = ?`,
    [ctx.userId, phone]
  );
  if (!row?.id) return;

  const updates: string[] = [];
  const params: any[] = [];

  // stage
  if (payload?.stage) {
    updates.push("stage = ?");
    params.push(String(payload.stage));
  }

  // tags
  if (payload?.tag) {
    let tags: string[] = [];
    try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { }
    const tagStr = String(payload.tag);
    if (!tags.includes(tagStr)) tags.push(tagStr);
    updates.push("tags = ?");
    params.push(JSON.stringify(tags));
  }

  // notes
  if (payload?.note) {
    const noteObj = {
      text: String(payload.note),
      created_at: Date.now(),
    };
    const client = await db.get<{ notes: string | null }>(
      `SELECT notes FROM crm WHERE id = ?`,
      [row.id]
    );
    let notesArr: any[] = [];
    try { notesArr = client?.notes ? JSON.parse(client.notes) : []; } catch { }
    notesArr.unshift(noteObj);
    updates.push("notes = ?");
    params.push(JSON.stringify(notesArr));
  }

  if (!updates.length) return;
  params.push(row.id);

  await db.run(
    `UPDATE crm SET ${updates.join(", ")} WHERE id = ?`,
    params
  );
}

async function callWebhookFromFlow(
  payload: any,
  ctx: FlowContext
): Promise<void> {
  const url = String(payload?.url || "").trim();
  if (!url) return;

  const body = {
    user_id: ctx.userId,
    session_name: ctx.sessionName,
    chat_id: ctx.chatId,
    phone: ctx.phone || extrairNumero(ctx.chatId),
    contact_name: ctx.contactName || null,
    message: ctx.messageBody,
    crm: {
      stage: ctx.crm?.stage || null,
      tags: ctx.crm?.tags || [],
    },
    time: {
      date: ctx.localDateStr,
      time: ctx.localTimeStr,
      hour: ctx.localHour,
    },
    last_ai_response: ctx.lastResponse || null,
  };

  const config: any = {};
  if (payload?.headers && typeof payload.headers === "object") {
    config.headers = payload.headers;
  }

  await axios.post(url, body, {
    timeout: Number(payload?.timeout_ms || 8000),
    ...config,
  });
}

function matchesBranchCondition(cond: BranchCondition | null, ctx: FlowContext): boolean {
  if (!cond) return false;
  const text = (ctx.messageBody || "").toLowerCase();
  const list = Array.isArray(cond.contains)
    ? cond.contains
    : cond.contains
      ? [cond.contains]
      : [];
  if (!list.length) return false;
  return list.some((c) => text.includes(String(c || "").toLowerCase()));
}

type RunOptions = { simulate?: boolean; logs?: string[] };
const FLOW_MAX_ACTIONS = 100; // limite de ações por execução para evitar loops abusivos
const FLOW_MAX_MESSAGE_CHARS = 4000; // limite de tamanho do texto enviado em send_text

async function runFlowActions(
  actions: any[],
  ctx: FlowContext,
  options: RunOptions = {},
  depth = 0
): Promise<void> {
  if (!Array.isArray(actions) || !actions.length) return;
  if (depth > 5) return; // safety guard

  let executed = 0;
  for (const a of actions) {
    executed += 1;
    if (executed > FLOW_MAX_ACTIONS) {
      console.warn("Flow abortado: limite de ações excedido", {
        userId: ctx.userId,
        chatId: ctx.chatId,
        session: ctx.sessionName,
        limit: FLOW_MAX_ACTIONS,
      });
      break;
    }

    if (!a?.type) continue;

    if (a.type === "send_text") {
      const rendered = renderFlowTemplate(String(a.payload || ""), ctx);
      const trimmed = rendered.length > FLOW_MAX_MESSAGE_CHARS
        ? rendered.slice(0, FLOW_MAX_MESSAGE_CHARS)
        : rendered;
      if (options.simulate) {
        options.logs?.push(`send_text: ${trimmed}` + (trimmed.length < rendered.length ? " [truncated]" : ""));
      } else {
        try {
          await withTimeout(ctx.client.sendText(ctx.chatId, trimmed), WPP_TIMEOUT_MS, "sendText");
          ctx.lastResponse = trimmed;
        } catch { }
      }
    }

    else if (a.type === "delay") {
      const s = Number(a.payload) || 1;
      if (options.simulate) {
        options.logs?.push(`delay: ${s}s`);
      } else {
        await new Promise((r) => setTimeout(r, s * 1000));
      }
    }

    else if (a.type === "send_media") {
      if (options.simulate) {
        options.logs?.push(`send_media: ${String(a.payload || "")}`);
      } else {
        try {
          await withTimeout(
            ctx.client.sendFile(ctx.chatId, String(a.payload), "arquivo", ""),
            WPP_TIMEOUT_MS,
            "sendFile"
          );
        } catch (err) {
          console.warn("Erro ao enviar mídia em flow:", err);
        }
      }
    }

    else if (a.type === "update_crm") {
      if (options.simulate) {
        options.logs?.push(`update_crm: ${JSON.stringify(a.payload || {})}`);
      } else {
        try {
          await applyCrmUpdateFromFlow(a.payload || {}, ctx);
        } catch (err) {
          console.error("Erro update_crm em flow:", err);
        }
      }
    }

    else if (a.type === "call_webhook") {
      if (options.simulate) {
        options.logs?.push(`call_webhook: ${JSON.stringify(a.payload || {})}`);
      } else {
        try {
          await callWebhookFromFlow(a.payload || {}, ctx);
        } catch (err) {
          console.error("Erro call_webhook em flow:", err);
        }
      }
    }

    else if (a.type === "handover_human") {
      if (options.simulate) {
        options.logs?.push("handover_human");
      } else {
        try {
          await withTimeout(
            ctx.client.sendText(
              ctx.chatId,
              " Vou transferir você para um atendente humano. Aguarde..."
            ),
            WPP_TIMEOUT_MS,
            "sendText"
          );
        } catch { }

        try {
          enableHumanTemporarily(ctx.userId, ctx.sessionName, ctx.chatId);
        } catch { }

        try {
          emitToUser(ctx.userId, "human_request", {
            chatId: ctx.chatId,
            userId: ctx.userId,
            sessionName: ctx.sessionName,
          });
        } catch { }
      }
    }

    else if (a.type === "branch") {
      const cond: BranchCondition | null = a.condition || a.payload?.condition || null;
      const thenActions = a.then || a.true || a.payload?.thenActions || [];
      const elseActions = a.else || a.false || a.payload?.elseActions || [];
      const goThen = matchesBranchCondition(cond, ctx);
      if (options.simulate) {
        options.logs?.push(`branch -> ${goThen ? "then" : "else"}`);
      }
      await runFlowActions(goThen ? thenActions : elseActions, ctx, options, depth + 1);
    }
  }
}

export async function simulateFlowRun(flow: any, ctx: FlowContext) {
  const logs: string[] = [];

  if (flow.active === 0 || flow.active === false) {
    return { matched: false, conditionPassed: false, logs };
  }

  let triggers: string[] = [];
  try {
    if (flow.triggers) triggers = JSON.parse(flow.triggers);
  } catch { }
  if (!Array.isArray(triggers) || !triggers.length) {
    const legacy = (flow.trigger || flow.trigger_type || "").trim();
    if (legacy) triggers = [legacy];
  }

  const lower = ctx.messageBody.toLowerCase();
  const matched = triggers.some((t) => t && lower.includes(String(t).toLowerCase()));
  if (!matched) return { matched: false, conditionPassed: false, logs };

  let conditions: FlowConditions | null = null;
  try {
    conditions = flow.conditions ? JSON.parse(flow.conditions) : null;
  } catch { }

  const conditionPassed = matchFlowConditions(conditions, ctx);
  if (!conditionPassed) return { matched: true, conditionPassed: false, logs };

  const actions = JSON.parse(flow.actions || "[]");
  await runFlowActions(actions, ctx, { simulate: true, logs });

  return { matched: true, conditionPassed: true, logs };
}

export async function simulateWelcomeFlow(actions: any[], ctx: FlowContext) {
  const logs: string[] = [];
  await runFlowActions(actions, ctx, { simulate: true, logs });
  return { logs };
}

async function transcribeAudio(buffer: Buffer, mimetype?: string): Promise<string | null> {
  if (!buffer?.length) return null;

  // Deepgram (free tier com chave)
  if (AUDIO_TRANSCRIBE_PROVIDER === "deepgram") {
    if (!DEEPGRAM_API_KEY) {
      console.warn("Deepgram selecionado, mas DEEPGRAM_API_KEY não foi definido.");
      return null;
    }
    try {
      const res = await axios.post(
        "https://api.deepgram.com/v1/listen",
        buffer,
        {
          headers: {
            Authorization: `Token ${DEEPGRAM_API_KEY}`,
            "Content-Type": mimetype || "audio/ogg",
            Accept: "application/json",
          },
          params: {
            punctuate: true,
            language: "pt-BR",
          },
          timeout: 15000,
        }
      );
      const transcript =
        res?.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      return transcript.trim().length ? transcript.trim() : null;
    } catch (err) {
      console.error("Erro Deepgram:", err?.response?.data || err?.message || err);
      return null;
    }
  }

  // Google (pago — requer credenciais e billing)
  const client = getSpeechClientSafe();
  if (!client) return null;

  try {
    // tenta inferir encoding pelo mimetype; padrão ogg/opus (WhatsApp)
    const encodingMap: Record<string, any> = {
      "audio/ogg": "OGG_OPUS",
      "audio/opus": "OGG_OPUS",
      "audio/webm": "WEBM_OPUS",
      "audio/mp4": "MP4",
      "audio/mpeg": "MP3",
      "audio/mp3": "MP3",
    };
    const encoding = encodingMap[String(mimetype || "").toLowerCase()] || "OGG_OPUS";

    const [result] = await client.recognize({
      audio: { content: buffer.toString("base64") },
      config: {
        encoding,
        languageCode: "pt-BR",
        enableAutomaticPunctuation: true,
      },
    });

    const transcript = result?.results?.[0]?.alternatives?.[0]?.transcript;
    return transcript && transcript.trim().length ? transcript.trim() : null;
  } catch (err) {
    console.error("Erro ao transcrever áudio:", err);
    return null;
  }
}
function isDisconnectedState(state: string) {
  const s = String(state || "").toLowerCase();

  return (
    s.includes("disconnected") ||
    s.includes("unpaired") ||
    s.includes("serverclose") ||
    s.includes("browserclose") ||
    s.includes("conflict") ||
    s.includes("timeout") ||
    s.includes("logout")
  );
}



//  Agora todos os mapas são por sessão+chat (full::chatId)
export const messageBuffer = new Map<string, string[]>();
export const messageTimeouts = new Map<string, NodeJS.Timeout>();
const pausedChats = new Map<string, boolean>();
const humanTimeouts = new Map<string, NodeJS.Timeout>();

export function cancelAIDebounce(chatKey: string) {
  // cancela timeout
  const t = messageTimeouts.get(chatKey);
  if (t) clearTimeout(t);

  // remove tudo
  messageTimeouts.delete(chatKey);
  messageBuffer.delete(chatKey);

  console.log(" IA debounce cancelado:", chatKey);
}


// ===========================
// HELPERS
// ===========================


export function getQRPathFor(full: string) {
  const qrFolder = path.join(process.cwd(), "qr");
  ensureDir(qrFolder);
  return path.join(qrFolder, `${full}.png`);
}

// limpa buffers/timers da SESSÃO específica
function clearSessionMemory(full: string) {
  const prefix = `${full}::`;

  // buffer de mensagens
  for (const key of Array.from(messageBuffer.keys())) {
    if (key.startsWith(prefix)) {
      messageBuffer.delete(key);
    }
  }

  // timeouts de resposta
  for (const [key, timeout] of Array.from(messageTimeouts.entries())) {
    if (key.startsWith(prefix)) {
      clearTimeout(timeout);
      messageTimeouts.delete(key);
    }
  }

  // chats pausados
  for (const key of Array.from(pausedChats.keys())) {
    if (key.startsWith(prefix)) {
      pausedChats.delete(key);
    }
  }

  // timeouts de modo humano (se usados em outro lugar)
  for (const [key, timeout] of Array.from(humanTimeouts.entries())) {
    if (key.startsWith(prefix)) {
      clearTimeout(timeout);
      humanTimeouts.delete(key);
    }
  }
}

// ===========================
//  MODO HUMANO POR INATIVIDADE (5 MIN) — MULTI-SESSÃO
// ===========================
const HUMAN_INACTIVITY_DEFAULT_MS = 5 * 60 * 1000; // padrão: 5 min

// true = humano ativo (IA bloqueada)
export const chatHumanLock = new Map<string, boolean>();

// timer por chat
export const chatHumanTimer = new Map<string, NodeJS.Timeout>();

// último timestamp de atividade do cliente
export const chatHumanLastActivity = new Map<string, number>();
export const chatHumanDuration    = new Map<string, number | null>(); // null = sem limite

function getHumanKey(
  userId: string | number,
  sessionName: string,
  chatId: string
) {
  return `USER${userId}_${sessionName}::${chatId}`;
}

type HumanActivationOptions = {
  contactMessage?: string | null;
  sendTransferMessage?: boolean;
};

const FALLBACK_REASON_LABELS: Record<FallbackReason, string> = {
  user_request: "Cliente pediu atendimento humano",
  repetition_limit: "Mensagens repetidas detectadas",
  frustration_limit: "Frustração detectada",
  ai_failure: "Falha da IA",
  ai_uncertainty: "IA sem confiança suficiente",
  ai_transfer: "IA pediu transferência",
  cooldown: "Chat ainda em cooldown",
  silence_window: "Horário de silêncio",
};

function getFallbackReasonLabel(reason?: FallbackReason) {
  if (!reason) return "Fallback automático";
  return FALLBACK_REASON_LABELS[reason] || "Fallback automático";
}

function emitSystemNote(
  userId: string | number,
  sessionName: string,
  chatId: string,
  note: {
    type: string;
    title?: string;
    message: string;
    timestamp?: number;
    detail?: string | null;
  }
) {
  try {
    emitToUser(userId, "system_note", {
      chatId,
      userId,
      sessionName,
      type: note.type,
      title: note.title || "Nota interna",
      message: note.message,
      detail: note.detail || null,
      timestamp: note.timestamp || Date.now(),
    });
  } catch { }
}

/**
 *  Ativa modo humano
 * Expira quando ficar 5 min sem mensagem do cliente.
 */
export function enableHumanTemporarily(
  userId: string | number,
  sessionName: string,
  chatId: string,
  durationMs: number | null = HUMAN_INACTIVITY_DEFAULT_MS,  // null = sem limite
  options: HumanActivationOptions = {}
) {
  const key = getHumanKey(userId, sessionName, chatId);

  chatHumanLock.set(key, true);
  chatHumanLastActivity.set(key, Date.now());
  chatHumanDuration.set(key, durationMs);

  if (chatHumanTimer.has(key)) {
    clearTimeout(chatHumanTimer.get(key)!);
    chatHumanTimer.delete(key);
  }

  // Só agenda expiração se tiver duração definida
  if (durationMs !== null) {
    const timer = setTimeout(() => {
      tryDisableHumanByInactivity(userId, sessionName, chatId);
    }, durationMs);
    chatHumanTimer.set(key, timer);
  }

  const messageToSend = String(options.contactMessage || "").trim();
  const shouldSendToContact =
    options.sendTransferMessage === true && messageToSend.length > 0;

  if (shouldSendToContact) {
    sendSystemMessage(
      userId,
      sessionName,
      chatId,
      messageToSend
    );
  }

  try {
    emitToUser(userId, "human_state_changed", {
      chatId,
      userId,
      sessionName,
      state: true,
      expireAt: durationMs !== null ? Date.now() + durationMs : null
    });

  } catch { }

  console.log(` MODO HUMANO ATIVADO: ${key} | duração: ${durationMs === null ? "sem limite" : durationMs / 60000 + "min"}`);
}


/**
 * Sempre que chegar mensagem do cliente, chama isso.
 * Zera o contador de inatividade.
 */
export function registerHumanActivity(
  userId: string | number,
  sessionName: string,
  chatId: string
) {
  const key = getHumanKey(userId, sessionName, chatId);

  if (chatHumanLock.get(key) !== true) return;

  chatHumanLastActivity.set(key, Date.now());

  if (chatHumanTimer.has(key)) {
    clearTimeout(chatHumanTimer.get(key)!);
    chatHumanTimer.delete(key);
  }

  // Usar a duração original configurada pelo operador
  const actualDuration = chatHumanDuration.get(key) ?? HUMAN_INACTIVITY_DEFAULT_MS;

  // Só agenda timer se tiver duração definida (null = sem limite)
  if (actualDuration !== null) {
    const timer = setTimeout(() => {
      tryDisableHumanByInactivity(userId, sessionName, chatId);
    }, actualDuration);
    chatHumanTimer.set(key, timer);
  }

  // Atualiza painel ao vivo com a duração correta
  try {
    emitToUser(userId, "human_state_changed", {
      chatId,
      userId,
      sessionName,
      state: true,
      expireAt: actualDuration !== null ? Date.now() + actualDuration : null,
    });
  } catch { }
}


function tryDisableHumanByInactivity(
  userId: string | number,
  sessionName: string,
  chatId: string
) {
  const key = getHumanKey(userId, sessionName, chatId);

  // se nem está em modo humano, sai
  if (chatHumanLock.get(key) !== true) return;

  const last = chatHumanLastActivity.get(key) || Date.now();
  const inactiveFor = Date.now() - last;
  const actualDuration = chatHumanDuration.get(key) ?? HUMAN_INACTIVITY_DEFAULT_MS;

  // ainda não atingiu o tempo -> recalcula tempo restante
  if (actualDuration !== null && inactiveFor < actualDuration) {
    const remaining = actualDuration - inactiveFor;

    if (chatHumanTimer.has(key)) {
      clearTimeout(chatHumanTimer.get(key)!);
      chatHumanTimer.delete(key);
    }

    const timer = setTimeout(() => {
      tryDisableHumanByInactivity(userId, sessionName, chatId);
    }, remaining);

    chatHumanTimer.set(key, timer);
    return;
  }

  // ===========================
  // OK DESATIVOU MODO HUMANO
  // ===========================
  chatHumanLock.set(key, false);
  chatHumanLastActivity.delete(key);

  if (chatHumanTimer.has(key)) {
    clearTimeout(chatHumanTimer.get(key)!);
    chatHumanTimer.delete(key);
  }

  // limpa estado de runtime (repetição/frustração) para evitar reativação imediata
  clearFallbackRuntime(Number(userId), sessionName, chatId);

  emitSystemNote(userId, sessionName, chatId, {
    type: "bot_resume",
    title: "Assistente automático",
    message:
      "O assistente automático reassumiu a conversa por inatividade no atendimento humano.",
  });

  // ===========================
  // OK AVISA O PAINEL
  // ===========================
  try {
    emitToUser(userId, "human_state_changed", {
      chatId,
      userId,
      sessionName,
      state: false,
      expireAt: null,
    });
  } catch { }

  console.log(` BOT reassumiu por inatividade: ${key}`);
}




async function handleAutomaticFallback(options: {
  decision: FallbackDecision;
  userId: number;
  sessionName: string;
  chatId: string;
  chatKey: string;
  client: any;
}) {
  const { decision, userId, sessionName, chatId, chatKey, client } = options;
  const humanKey = getHumanKey(userId, sessionName, chatId);

  if (chatHumanLock.get(humanKey) === true) return;

  cancelAIDebounce(chatKey);
  messageBuffer.delete(chatKey);

  try {
    await client.stopTyping(chatId);
  } catch { }

  const duration =
    decision.config.humanDurationMs === null
      ? null
      : (decision.config.humanDurationMs ?? HUMAN_INACTIVITY_DEFAULT_MS);

  enableHumanTemporarily(
    userId,
    sessionName,
    chatId,
    duration,
    {
      contactMessage: decision.config.fallbackMessage,
      sendTransferMessage:
        decision.config.sendTransferMessage === true &&
        decision.config.internalNoteOnly !== true,
    }
  );

  clearFallbackRuntime(userId, sessionName, chatId);

  if (decision.config.notifyPanel !== false) {
    const label = getFallbackReasonLabel(decision.reason);
    const detail = decision.matchedPhrase
      ? `Frase que disparou: "${decision.matchedPhrase}".`
      : null;
    const message = detail
      ? `${label}. ${detail}`
      : label;

    emitSystemNote(userId, sessionName, chatId, {
      type: "fallback",
      title: "Fallback automático",
      message,
      detail,
      timestamp: Date.now(),
    });
  }

  if (decision.config.notifyWebhook && decision.config.webhookUrl) {
    try {
      await deliverWebhook({
        userId,
        url: decision.config.webhookUrl,
        eventType: "fallback_handoff",
        payload: {
          chatId,
          userId,
          sessionName,
          reason: decision.reason,
          configUsed: decision.config.source === "db",
          matchedPhrase: decision.matchedPhrase || null,
          triggeredAt: Date.now(),
        },
      });
    } catch (err) {
      console.error("Erro ao acionar webhook de fallback:", err);
    }
  }

  if (decision.config.alertPhone) {
    const template = decision.config.alertMessage || "Alerta: assuma a conversa {chatId} da sessão {sessionName}.";
    const msg = template
      .replace(/{chatId}/g, chatId.replace("@c.us", ""))
      .replace(/{sessionName}/g, sessionName);

    try {
      const numberOnly = decision.config.alertPhone.replace(/\D/g, "");
      const targetJid = await ensureChat(client, numberOnly);
      await withTimeout(client.sendText(targetJid, msg), WPP_TIMEOUT_MS, "sendText");
    } catch (err) {
      console.error("Erro ao enviar alerta de fallback por WhatsApp:", err);
    }
  }

  // registra cooldown
  if (decision.config.cooldownMs !== null) {
    markFallbackTimestamp(userId, sessionName, chatId);
  }

  console.log(`ALERTA Fallback automático → humano | ${humanKey} | motivo: ${decision.reason}`);
}


// ===========================
//  LIMPAR TOKENS INATIVOS
// ===========================
export async function cleanupInactiveTokens() {
  const tokensRoot = path.join(process.cwd(), "tokens");
  ensureDir(tokensRoot);

  const db = await getDB();

  //  sessões válidas no banco
  const sessions = await db.all<{
    user_id: number;
    session_name: string;
  }>(`SELECT user_id, session_name FROM sessions`);

  // transforma em Set para lookup rápido
  const validSessions = new Set(
    sessions.map(s => `USER${s.user_id}_${s.session_name}`)
  );

  const dirs = fs.readdirSync(tokensRoot, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let removed = 0;

  for (const dir of dirs) {
    if (!validSessions.has(dir)) {
      const fullPath = path.join(tokensRoot, dir);

      console.log(" Token inativo encontrado:", dir);

      try {
        const ok = await safeRmDir(fullPath);
        if (ok) {
          removed++;
          console.log("OK Token removido:", dir);
        } else {
          console.warn("ALERTA Falha ao remover token:", dir);
        }
      } catch (err) {
        console.error("ERRO Erro ao remover token:", dir, err);
      }
    }
  }

  console.log(` Limpeza concluída. Tokens removidos: ${removed}`);
}

function killSessionBrowserProcesses(dir: string) {
  try {
    if (process.platform === "win32") {
      try {
        const list = execSync(
          `wmic process where "CommandLine like '%${dir.replace(
            /\\/g,
            "\\\\"
          )}%' and name like '%chrome%'" get ProcessId /value`,
          { encoding: "utf8" }
        );

        const pids = list
          .split("\n")
          .map((l) => l.replace("ProcessId=", "").trim())
          .filter(Boolean);

        for (const pid of pids) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
            console.log(" Matando Chrome da sessão -> PID", pid);
          } catch { }
        }
      } catch { }
      return;
    }

    try {
      execSync(`pkill -f "${dir}"`, { stdio: "ignore" });
    } catch { }
  } catch { }
}

async function closeSessionRuntime(full: string, sessionDir?: string, clientOverride?: any) {
  const trackedClient = clients.get(full);
  const client = trackedClient || clientOverride;
  if (client) {
    try {
      await client.close();
    } catch { }
    if (trackedClient) {
      clients.delete(full);
    }
  }

  if (sessionDir) {
    killSessionBrowserProcesses(sessionDir);
    clearChromiumLocks(sessionDir);
  }

  eventsAttached.delete(full);
  clearSessionMemory(full);
}

// ===========================
// REMOVER PASTA DA SESSÃO (SAFE)
// ===========================
async function safeRmDir(dir: string) {
  try {
    killSessionBrowserProcesses(dir);

    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch { }

  return false;
}

// ===========================
// DELETAR SESSÃO COMPLETA
// ===========================
export async function deleteWppSession(userId: number, sessionName: string) {
  const full = `USER${userId}_${sessionName}`;
  const TOKENS_DIR = process.env.TOKENS_DIR || "/app/tokens";
  const sessionDir = path.join(TOKENS_DIR, full);

  console.log(" Apagando sessão COMPLETA:", full);

  try {
    await closeSessionRuntime(full, sessionDir);

    //  remover QR
    const qrPath = getQRPathFor(full);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

    //  APAGAR TOKEN (PASTA DA SESSÃO)
    if (fs.existsSync(sessionDir)) {
      const removed = await safeRmDir(sessionDir);
      console.log(
        removed
          ? " Token (userDataDir) removido"
          : "ALERTA Falha ao remover token"
      );
    }

    //  remover do banco
    const db = await getDB();
    await db.run(
      `DELETE FROM sessions WHERE user_id = ? AND session_name = ?`,
      [userId, sessionName]
    );

    resetReconnectTracking(full);
    reconnecting.delete(full);

  console.log("OK Sessão totalmente removida:", full);
  logAudit("session_deleted", userId, "session", sessionName);
  return true;

} catch (err) {
  console.error("ERRO ao apagar sessão:", err);
  return false;
}
}
function extrairNumero(chatId: string) {
  const raw = chatId.replace("@c.us", "").replace("@g.us", "");
  const sanitized = sanitizePhone(raw);
  const { ok } = validatePhone(sanitized);
  return ok ? sanitized : "";
}


// ===============================
//  FUNÇÃO QUE ANEXA EVENTOS (SEM DUPLICAR) + MODO HUMANO + IA POR CHAT + DIGITANDO
// ===============================
async function attachEvents(
  client: wppconnect.Whatsapp,
  userId: number,
  shortName: string
) {
  const full = `USER${userId}_${shortName}`;

  await withSessionLock(full, async () => {
  if (eventsAttached.has(full)) {
    console.log(`ALERTA Eventos já anexados para ${full}, ignorando...`);
    return;
  }
  console.log(` Anexando eventos para ${full}...`);
  eventsAttached.add(full);

  client.onMessage(async (msg) => {
    let typingTimeout: NodeJS.Timeout | null = null;

    // =================================================
    //  BLOQUEIO TOTAL DE STATUS / STORY (100% SAFE)
    // =================================================
    const chatId = String(msg.chatId || msg.from || "");
    if (chatId === "status@broadcast") return;

    // =================================================
    //  IGNORAR GRUPOS
    // =================================================
    if (msg.isGroupMsg || chatId.endsWith("@g.us")) return;

    // =================================================
    //  NÃO RESPONDER MENSAGEM DO PRÓPRIO BOT (ANTI-LOOP)
    // =================================================
    if (msg.fromMe === true) return;

    // =================================================
    //  MENSAGEM INVÁLIDA
    // =================================================
    if (!chatId) return;

    // =================================================
    //  CHAVES DE CONTROLE (usadas em diversos pontos abaixo)
    // =================================================
    const fullKey = `USER${userId}_${shortName}`;
    const chatKey = `${fullKey}::${chatId}`;
    const humanKey = getHumanKey(userId, shortName, chatId);
    const aiKey = `USER${userId}_${chatId}`;

    touchChatActivity(chatKey, aiKey);

    // Precarrega cache de IA por chat do banco (persistência entre restarts)
    await primeChatAICache(userId);

    // =================================================
    //  DETECTAR ÁUDIO
    // =================================================
    const isAudio =
      msg.type === "ptt" ||
      msg.type === "audio" ||
      (msg.mimetype && String(msg.mimetype).includes("audio"));
    const isDocument =
      msg.type === "document" ||
      (msg.mimetype && String(msg.mimetype).startsWith("application/"));

    // =================================================
    //  BODY / TEXTO (inclui transcrição do WhatsApp)
    // =================================================
    const rawBody = String(msg.body || "").trim();
    const rawCaption = String((msg as any).caption || "").trim();
    const rawText = String((msg as any).text || "").trim();

    // =================================================
    //  PEGAR TEXTO FINAL
    // - Se for áudio: tenta usar transcrição do WhatsApp
    // - Se for texto normal: usa body normal
    // =================================================
    let body = "";

    // Texto normal
    if (!isAudio) {
      body = rawBody || rawText || rawCaption;
    }

    // Áudio -> tenta usar transcrição do WhatsApp; se não houver, transcreve via Google Speech
    if (isAudio) {
      body = rawBody || rawCaption || rawText;

      if (!body) {
        try {
          const audioBuffer = await client.decryptFile(msg);
          body = (await transcribeAudio(audioBuffer, msg.mimetype)) || "";
        } catch (err) {
          console.error("Erro ao obter/transcrever áudio:", err);
          body = "";
        }
      }

      // se ainda não entendeu, avisa e sai
      if (!body) {
        try {
          await withTimeout(client.sendText(chatId, "Não entendi o áudio, pode resumir em texto?"), WPP_TIMEOUT_MS, "sendText");
        } catch { }
        return;
      }
    }

    // =================================================
    //  NÃO RESPONDER MENSAGEM VAZIA
    // =================================================
    body = body.trim();
    const mediaSeconds = isAudio ? Number((msg as any).duration || (msg as any).seconds || 0) : null;
    const hasText = body.length > 0;

    // se não há texto (ex: documento sem legenda), ainda podemos considerar fallback por mídia
    if (!hasText && (isAudio || isDocument)) {
      try {
        const fbMedia = await checkFallbackTriggers({
          userId,
          sessionName: shortName,
          chatId,
          event: "user_message",
          message: body,
          mediaType: isAudio ? "audio" : isDocument ? "document" : undefined,
          mediaSeconds,
          hasText,
        });

        if (fbMedia.shouldFallback) {
          await handleAutomaticFallback({
            decision: fbMedia,
            userId,
            sessionName: shortName,
            chatId,
            chatKey,
            client,
          });
        }
      } catch (err) {
        console.error("Erro ao avaliar fallback (mídia sem texto):", err);
      }

      return;
    }

    if (!hasText) return;

    try {
      let isNewContact = false;
      let crmForFlow: { stage?: string | null; tags?: string[] } | undefined;

      // =================================================
      //  SALVAR / ATUALIZAR CRM
      // =================================================
      try {
        const crmResult = await saveCRMClient(userId, shortName, msg);
        isNewContact = crmResult?.isNew || false;
        crmForFlow = crmResult?.crmData || undefined;
      } catch { }
      let offsetMinutes = -180;

      const userDate = () => new Date(Date.now() + offsetMinutes * 60000); // UTC-shifted; use getUTCHours() to avoid host TZ

      // =================================================
      //  CONTADOR DE MENSAGENS (p/ "primeira mensagem" em flows)
      // =================================================
      const currentCount = inboundCount.get(chatKey) || 0;
      inboundCount.set(chatKey, currentCount + 1);
      const isFirstMessage = currentCount === 0;
      const phoneForCtx = extrairNumero(chatId);
      const contactName =
        msg.sender?.pushname ||
        msg.sender?.name ||
        msg.sender?.shortName ||
        phoneForCtx;

      // =================================================
      //  ENVIAR PARA O PAINEL (REALTIME)
      // =================================================
      let mediaBase64: string | null = null;
      let mediaMime: string | undefined = msg.mimetype || undefined;

      // Se for áudio, já decripta para permitir reprodução no painel
      if (isAudio) {
        try {
          const audioBuffer = await client.decryptFile(msg);
          mediaBase64 = audioBuffer.toString("base64");
          mediaMime = msg.mimetype || "audio/ogg";
        } catch (err) {
          console.error("Erro ao obter áudio para painel:", err);
        }
      }

      try {
        const payload: any = {
          chatId,
          name:
            msg.sender?.pushname ||
            msg.sender?.name ||
            msg.sender?.shortName ||
            chatId.replace("@c.us", ""),
          body,
          mimetype: mediaMime || msg.mimetype,
          isMedia: !!(msg.mimetype || mediaBase64),
          timestamp: (msg.timestamp || Date.now()) * 1000,
          fromMe: !!msg.fromMe,
          _isFromMe: !!msg.fromMe,
          avatar: msg.sender?.profilePicThumbObj?.eurl || null,
        };
        if (mediaBase64) {
          payload.mediaBase64 = mediaBase64;
          payload.mediaText = body; // transcrição/texto original
        }
        emitToUser(userId, "newMessage", payload);
      } catch { }

      const consentCommand = detectDispatchConsentCommand(body);
      if (consentCommand) {
        try {
          const db = getDB();
          if (consentCommand.type === "opt_out") {
            await upsertDispatchSuppression({
              userId,
              phone: phoneForCtx,
              reason: "opt_out_keyword",
              source: "inbound_message",
              notes: consentCommand.normalizedText,
              db,
            });
            await logAudit("dispatch_opt_out", userId, "phone", phoneForCtx, {
              session: shortName,
              command: consentCommand.normalizedText,
            });
            await withTimeout(
              client.sendText(
                chatId,
                "Tudo certo. Vou respeitar sua preferencia e parar os envios automáticos para este número. Se quiser voltar, responda VOLTAR."
              ),
              WPP_TIMEOUT_MS,
              "sendText"
            );
          } else {
            await clearDispatchSuppression({
              userId,
              phone: phoneForCtx,
              source: "inbound_message",
              notes: consentCommand.normalizedText,
              db,
            });
            await logAudit("dispatch_opt_in", userId, "phone", phoneForCtx, {
              session: shortName,
              command: consentCommand.normalizedText,
            });
            await withTimeout(
              client.sendText(
                chatId,
                "Perfeito. Este número voltou a poder receber comunicações automáticas."
              ),
              WPP_TIMEOUT_MS,
              "sendText"
            );
          }
        } catch (err) {
          console.error("Erro ao processar opt-out/opt-in de disparo:", err);
        }

        messageBuffer.delete(chatKey);
        try {
          await client.stopTyping(chatId);
        } catch { }
        return;
      }

      // =================================================
      //  MODO HUMANO ATIVO → NÃO RESPONDER
      // MAS: atualiza atividade para expirar por INATIVIDADE
      // =================================================
      if (chatHumanLock.get(humanKey) === true) {
        //  zera timer de inatividade (cliente falou)
        try {
          registerHumanActivity(userId, shortName, chatId);
        } catch { }

        messageBuffer.delete(chatKey);

        try {
          await client.stopTyping(chatId);
        } catch { }

        return;
      }



      // =================================================
      //  IA DESLIGADA PARA ESTE CHAT
      // =================================================
      const aiEnabledForChat = await getChatAIState(userId, chatId);
      if (!aiEnabledForChat) {
        messageBuffer.delete(chatKey);
        try {
          await client.stopTyping(chatId);
        } catch { }
        return;
      }

      // =================================================
      //  HORÁRIO DE SILÚNCIO
      // =================================================
      let userCfg: {
        ia_silence_start: number | null;
        ia_silence_end: number | null;
        timezone_offset: number | null;
      } | null = null;

      try {
        const db = getDB();
        userCfg = await db.get<{
          ia_silence_start: number | null;
          ia_silence_end: number | null;
          timezone_offset: number | null;
        }>(`SELECT ia_silence_start, ia_silence_end, timezone_offset FROM users WHERE id = ?`, [userId]);

        if (userCfg?.timezone_offset !== null && userCfg?.timezone_offset !== undefined && !Number.isNaN(Number(userCfg.timezone_offset))) {
          offsetMinutes = Number(userCfg.timezone_offset);
        }
      } catch (err) {
        console.warn("Falha ao carregar config de horário de silêncio:", err);
      }

      try {
        if (await isInSilenceWindow(userId)) {
          console.log(` IA silenciada para user ${userId}`);
          messageBuffer.delete(chatKey);
          try {
            await client.stopTyping(chatId);
          } catch { }
          return;
        }
      } catch (err) {
        console.warn("Erro ao avaliar horário de silêncio:", err);
      }

      // =================================================
      //  LIMITE DE PLANO IA
      // =================================================
      if (!(await canUseIA(userId))) {
        try {
          await client.stopTyping(chatId);
        } catch { }

        await withTimeout(
          client.sendText(
            chatId,
            "ALERTA Você atingiu o limite de mensagens IA do seu plano.\n\nFaça upgrade para continuar "
          ),
          WPP_TIMEOUT_MS,
          "sendText"
        );
        return;
      }

      const userNow = userDate();
      const localHour = userNow.getUTCHours();
      const localDateStr = userNow.toLocaleDateString("pt-BR", { timeZone: "UTC" });
      const localTimeStr = userNow.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

      // =================================================
      //  FLUXO DE BOAS-VINDAS (primeiro contato novo)
      // =================================================
      try {
        await executeWelcomeFlow({
          userId,
          sessionName: shortName,
          chatId,
          messageBody: body,
          client,
          crm: crmForFlow,
          localHour,
          isFirstMessage,
          contactName,
          phone: phoneForCtx,
          localDateStr,
          localTimeStr,
          lastResponse: undefined,
          isNewContact,
        });
      } catch { }

          // =================================================
          //  EXECUTAR FLOWS INTELIGENTES (com condições)
          // =================================================
          try {
            // CRM para condições de stage/tags
            if (!crmForFlow) {
              try {
                const db = await getDB();
                const phone = extrairNumero(chatId);
                const row = await db.get<{ stage: string | null; tags: string | null }>(
                  `SELECT stage, tags FROM crm WHERE user_id = ? AND phone = ?`,
                  [userId, phone]
                );
                crmForFlow = {
                  stage: row?.stage ?? null,
                  tags: row?.tags ? JSON.parse(row.tags) : [],
                };
              } catch { }
            }

            await executeUserFlows({
              userId,
              sessionName: shortName,
              chatId,
              messageBody: body,
              client,
              crm: crmForFlow,
              localHour,
              isFirstMessage,
              contactName,
              phone: phoneForCtx,
              localDateStr,
              localTimeStr,
              lastResponse: undefined,
            });
          } catch { }

      // =================================================
      //  FALLBACK AUTOMÁTICO (triggers de mensagem)
      // =================================================
      try {
        const fallbackDecision = await checkFallbackTriggers({
          userId,
          sessionName: shortName,
          chatId,
          event: "user_message",
          message: body,
          mediaType: isAudio ? "audio" : isDocument ? "document" : undefined,
          mediaSeconds,
          hasText: true,
        });

        if (fallbackDecision.shouldFallback) {
          await handleAutomaticFallback({
            decision: fallbackDecision,
            userId,
            sessionName: shortName,
            chatId,
            chatKey,
            client,
          });
          return;
        }
      } catch (err) {
        console.error("Erro ao avaliar fallback:", err);
      }

      // =================================================
      //  BUFFER DE MENSAGENS
      // =================================================
      if (!messageBuffer.has(chatKey)) {
        messageBuffer.set(chatKey, []);
      }
      messageBuffer.get(chatKey)!.push(body);

      // =================================================
      // ⏳ DEBOUNCE DA RESPOSTA
      // =================================================
      if (messageTimeouts.has(chatKey)) {
        clearTimeout(messageTimeouts.get(chatKey)!);
        messageTimeouts.delete(chatKey);
      }

      const timeout = setTimeout(async () => {
        try {
          if (chatHumanLock.get(humanKey) === true) {
            messageBuffer.delete(chatKey);
            try {
              await client.stopTyping(chatId);
            } catch { }
            return;
          }
          const db = await getDB();

          const userConfig = await db.get(
            `SELECT prompt, ia_enabled FROM users WHERE id = ?`,
            [userId]
          );

          // ERRO IA GLOBAL DESLIGADA
          if (!userConfig?.ia_enabled) {
            messageBuffer.delete(chatKey);
            try {
              await client.stopTyping(chatId);
            } catch { }
            return;
          }

          const prompt = userConfig?.prompt || "";
          const buffer = messageBuffer.get(chatKey) || [];

          // Segurança extra
          if (!buffer.length) {
            try {
              await client.stopTyping(chatId);
            } catch { }
            return;
          }

          // =================================================
          // DIGITANDO DIGITANDO (SÓ AQUI! DEPOIS DE CONFIRMAR QUE VAI RESPONDER)
          // =================================================
          try {
            await client.startTyping(chatId);
          } catch { }

          //  Avisar o painel que a IA está digitando
          try {
            emitToUser(userId, "typing:start", { chatId, userId, sessionName: shortName });
          } catch { }

          typingTimeout = setTimeout(() => {
            try {
              client.stopTyping(chatId);
            } catch { }
          }, 8000);

          let response = "";
          let aiFailed = false;

          for (let i = 1; i <= MAX_RETRIES; i++) {
            try {
              response = await generateAIResponse({
                aiSelected: AI_SELECTED,
                prompt,
                buffer,
                userId,
                sessionName: shortName,
                chatId,
                onStream: async (delta: string) => {
                  try {
                    emitToUser(userId, "ai:stream", {
                      chatId,
                      userId,
                      sessionName: shortName,
                      delta,
                    });
                  } catch { }
                }
              });
              break;
            } catch (err) {
              if (i === MAX_RETRIES) {
                aiFailed = true;
                response = "ERRO Erro ao responder no momento.";
              }
            }
          }

          if (aiFailed) {
            try {
              const fbError = await checkFallbackTriggers({
                userId,
                sessionName: shortName,
                chatId,
                event: "ai_error",
              });

              if (fbError.shouldFallback) {
                await handleAutomaticFallback({
                  decision: fbError,
                  userId,
                  sessionName: shortName,
                  chatId,
                  chatKey,
                  client,
                });
                return;
              }
            } catch (err) {
              console.error("Erro ao avaliar fallback (falha IA):", err);
            }
          }

          try {
            const fbAfterAI = await checkFallbackTriggers({
              userId,
              sessionName: shortName,
              chatId,
              event: "ai_response",
              aiResponse: response,
            });

            if (fbAfterAI.shouldFallback) {
              await handleAutomaticFallback({
                decision: fbAfterAI,
                userId,
                sessionName: shortName,
                chatId,
                chatKey,
                client,
              });
              return;
            }
          } catch (err) {
            console.error("Erro ao avaliar fallback (resposta IA):", err);
          }

          const messages = splitMessages(response);

          await sendMessagesWithDelay({
            client,
            messages,
            targetNumber: msg.from,
          });

          // OK CONSUMIR 1 MENSAGEM IA
          await consumeIaMessage(userId);
        } catch (err) {
          console.error("ERRO Erro no debounce IA:", err);
        } finally {
          //  limpar tudo
          messageBuffer.delete(chatKey);

          if (typingTimeout) clearTimeout(typingTimeout);

          //  GARANTE que para SEMPRE
          try {
            await client.stopTyping(chatId);
          } catch { }

          //  Avisar o painel que a IA parou de digitar
          try {
            emitToUser(userId, "typing:stop", { chatId, userId, sessionName: shortName });
          } catch { }
        }
      }, 1000);

      messageTimeouts.set(chatKey, timeout);
    } catch (err) {
      console.error("ERRO Erro no onMessage:", err);

      //  GARANTE stopTyping em erro também
      try {
        await client.stopTyping(chatId);
      } catch { }
    }
  });

  }); // fim lock sessão
}
// ===========================
//  RECONNECT SESSION
// ===========================
async function reconnectSession(userId: number, shortName: string, reason: unknown = "disconnected") {
  const full = `USER${userId}_${shortName}`;
  const TOKENS_DIR = process.env.TOKENS_DIR || "tokens";
  const sessionDir = path.join(TOKENS_DIR, full);

  if (reconnectCircuitOpen.has(full)) {
    const circuit = reconnectCircuitOpen.get(full)!;
    console.warn(
      `🚫 Auto-reconnect bloqueado para ${full}; circuito aberto após ${circuit.attempts} tentativa(s).`
    );
    return;
  }

  if (reconnecting.has(full)) {
    console.log("ALERTA Reconexão já em andamento:", full);
    return;
  }

  reconnecting.add(full);
  let shouldRecreate = false;

  try {
    await withSessionLock(full, async () => {
      const attempts = (reconnectAttempts.get(full) || 0) + 1;
      reconnectAttempts.set(full, attempts);

      if (attempts > RECONNECT_MAX_ATTEMPTS) {
        await closeSessionRuntime(full, sessionDir);
        await openReconnectCircuit(userId, shortName, reason, RECONNECT_MAX_ATTEMPTS);
        return;
      }

      // backoff simples (2s, 5s, 10s, 20s, 30s...)
      const delay = Math.min(30000, attempts === 1 ? 2000 : attempts * 5000);

      console.log(` Tentando reconectar ${full} (tentativa ${attempts}) em ${delay}ms...`);
      await wait(delay);

      await closeSessionRuntime(full, sessionDir);
      await updateSessionStatus(userId, shortName, "reconnecting");
      shouldRecreate = true;
    });

    if (!shouldRecreate) return;

    // recria sessão com o MESMO token (fora do lock para evitar deadlock com attachEvents)
    console.log(" Recriando sessão:", full);
    await createWppSession(userId, shortName, { source: "auto_reconnect" });

    console.log("OK Reconexão concluída:", full);
  } catch (err) {
    console.error("ERRO Falha ao reconectar:", full, err);
    const attempts = reconnectAttempts.get(full) || 0;
    await closeSessionRuntime(full, sessionDir);
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      await openReconnectCircuit(userId, shortName, err, attempts);
    } else {
      await updateSessionStatus(userId, shortName, "disconnected");
    }
  } finally {
    reconnecting.delete(full);
  }
}

// ===========================
// CRIAR SESSÃO + STATUS EM TEMPO REAL
// ===========================
async function doCreateWppSession(
  userId: number,
  shortName: string,
  options: CreateWppSessionOptions = {}
): Promise<{ sessionName: string; exists?: boolean }> {
  const full = `USER${userId}_${shortName}`;
  const TOKENS_DIR = process.env.TOKENS_DIR || "tokens";
  const sessionDir = path.join(TOKENS_DIR, full);
  const source = options.source || "manual_create";
  const automaticStart = isAutomaticSessionStart(source);

  if (clients.has(full)) {
    console.log("ALERTA Sessão já está carregada:", full);
    await primeFallbackCache(userId, shortName);
    return { sessionName: full, exists: true };
  }

  // garante registro no banco
  try {
    const db = await getDB();
    const existingSession = await db.get<{ status: string | null }>(
      `SELECT status FROM sessions WHERE user_id = ? AND session_name = ? LIMIT 1`,
      [userId, shortName]
    );

    if (
      automaticStart &&
      String(existingSession?.status || "").toLowerCase() === BANNED_SESSION_STATUS
    ) {
      bannedSessions.add(full);
      console.warn(`🚫 Ignorando ${source} para ${full}: sessao ja marcada como banned.`);
      return { sessionName: full, exists: true };
    }

    await db.run(
      `
      INSERT INTO sessions (user_id, session_name, status)
      SELECT ?, ?, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions WHERE user_id = ? AND session_name = ?
      )
      `,
      [userId, shortName, userId, shortName]
    );
    if (!existingSession || !automaticStart) {
      await db.run(
        `UPDATE sessions SET status = 'pending' WHERE user_id = ? AND session_name = ?`,
        [userId, shortName]
      );
    }
  } catch (err) {
    console.warn("Não foi possível garantir sessão no banco:", err);
  }

  ensureDir(TOKENS_DIR);
  ensureDir(sessionDir);

  // remove locks extras que o Chromium cria
  try {
    fs.rmSync(path.join(sessionDir, "SingletonLock"), { force: true });
    fs.rmSync(path.join(sessionDir, "SingletonCookie"), { force: true });
    fs.rmSync(path.join(sessionDir, "SingletonSocket"), { force: true });
  } catch { }

  clearChromiumLocks(sessionDir);
  console.log(" Criando sessão:", full);

  let client: wppconnect.Whatsapp | null = null;
  let autoRecoveryBlockedState: string | null = null;

  const createOptions: any = {
    session: full,

    //  ADICIONE ISSO
    autoClose: 0, // DESATIVA AUTO CLOSE TOTALMENTE

    puppeteerOptions: {
      headless: true,
      userDataDir: sessionDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
      ],
    },
    catchQR: async (base64Qrimg, asciiQR, attempts, urlCode) => {
      console.log(` QR (${full}) tentativa ${attempts}`);
      if (automaticStart) {
        autoRecoveryBlockedState = autoRecoveryBlockedState || "notLogged";
        try {
          const qrPath = getQRPathFor(full);
          if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
        } catch { }
        console.warn(`⚠️ QR suprimido para ${full} durante ${source}.`);
        return;
      }

      console.log(" QR salvo em:", getQRPathFor(full));
      if (base64Qrimg) {
        const base64 = base64Qrimg.split("base64,")[1];
        fs.writeFileSync(getQRPathFor(full), Buffer.from(base64, "base64"));
      }

      try {
        emitToUser(userId, "session:qr", { userId, sessionName: shortName, full });
      } catch { }

      if (urlCode) term(await qrcode.toString(urlCode, { type: "terminal" }));
    },
    statusFind: async (status) => {
      console.log(" STATUS FIND DISPAROU:", status);

      const db = await getDB();

      if (automaticStart && status === "notLogged") {
        autoRecoveryBlockedState = autoRecoveryBlockedState || status;
        return;
      }

      if (["inChat", "qrReadSuccess", "connected"].includes(status)) {
        console.log(" WHATSAPP CONECTADO — EMITINDO server:online");
        autoRecoveryBlockedState = null;
        resetReconnectTracking(full);

        await db.run(
          `UPDATE sessions SET status = 'connected' WHERE user_id = ? AND session_name = ?`,
          [userId, shortName]
        );

        try {
          emitToUser(userId, "server:online", { userId });
        } catch (err) {
          console.error("ERRO ERRO AO EMITIR server:online", err);
        }
      }

      if (["browserClose", "disconnectedMobile", "serverClose"].includes(status)) {
        if (reconnectCircuitOpen.has(full) || bannedSessions.has(full)) return;
        console.log(" WHATSAPP DESCONECTADO — EMITINDO server:offline");

        await db.run(
          `UPDATE sessions SET status = 'disconnected' WHERE user_id = ? AND session_name = ?`,
          [userId, shortName]
        );

        try {
          emitToUser(userId, "server:offline", { userId });
        } catch (err) {
          console.error("ERRO ERRO AO EMITIR server:offline", err);
        }
      }
    }
  };

  // só define a versão se o operador informar uma string válida (ex: 2.3000.1036983405);
  // evita versões inválidas como "2.3000.10305x" que geram warnings no WPPConnect.
  const envWaVersion = process.env.WA_VERSION;
  if (envWaVersion && /^[0-9]+\\.[0-9]+\\.[0-9]+/.test(envWaVersion)) {
    createOptions.whatsappVersion = envWaVersion;
  }

  client = await wppconnect.create(createOptions);

  if (automaticStart && autoRecoveryBlockedState) {
    const recoveryProbe = await probeAutoRecoveryBlock(
      client,
      source,
      autoRecoveryBlockedState
    );
    if (recoveryProbe.isBanned) {
      await markSessionAsBanned(
        userId,
        shortName,
        full,
        autoRecoveryBlockedState,
        recoveryProbe.reason,
        client
      );
    } else {
      await markSessionAsReauthRequired(
        userId,
        shortName,
        full,
        autoRecoveryBlockedState,
        recoveryProbe.reason,
        client
      );
    }
    return { sessionName: full };
  }

  await attachEvents(client, userId, shortName);

  client.onStateChange(async (state) => {
    console.log(` Estado da sessão ${full}:`, state);

    //  Emitir estado exato (conexão, reconexão, etc.)
    try {
      emitToUser(userId, "session:stateChange", {
        userId,
        sessionName: shortName,
        full,
        state,
      });
    } catch { }

    // ===========================
    //  AUTO RECONNECT
    // ===========================
    try {
      const normalizedState = String(state || "").toLowerCase();

      if (bannedSessions.has(full) && !normalizedState.includes("connected")) {
        return;
      }

      if (isDisconnectedState(state) || hasBanIndicator(state)) {
        if (reconnectCircuitOpen.has(full)) {
          console.warn("🚫 Circuit breaker aberto, ignorando auto-reconnect:", full);
          return;
        }

        const banSignal = await detectBanSignal(client, state);
        if (banSignal.isBanned) {
          await markSessionAsBanned(userId, shortName, full, state, banSignal.reason);
          return;
        }

        if (!isDisconnectedState(state)) {
          return;
        }

        console.log(" Estado indica desconexão -> auto-reconnect:", full);

        // marca offline
        try {
          const db = await getDB();
          await db.run(
            `UPDATE sessions SET status = 'disconnected' WHERE user_id = ? AND session_name = ?`,
            [userId, shortName]
          );
        } catch { }

        // emite offline
        try {
          emitToUser(userId, "server:offline", { userId });
        } catch { }

        // tenta reconectar
        reconnectSession(userId, shortName, state);
      }

      // reset tentativas quando conectar
      if (normalizedState.includes("connected")) {
        resetReconnectTracking(full);
      }
    } catch { }
  });


  clients.set(full, client);
  await primeFallbackCache(userId, shortName);
  await primeChatAICache(userId);
  logAudit("session_created", userId, "session", shortName);
  return { sessionName: full };
}

export async function createWppSession(
  userId: number,
  shortName: string,
  options: CreateWppSessionOptions = {}
): Promise<{ sessionName: string; exists?: boolean }> {
  const full = `USER${userId}_${shortName}`;

  if (clients.has(full)) {
    console.log("ALERTA Sessão já está carregada:", full);
    await primeFallbackCache(userId, shortName);
    return { sessionName: full, exists: true };
  }

  const inFlight = sessionCreationPromises.get(full);
  if (inFlight) {
    console.log("ALERTA Criação de sessão já em andamento:", full);
    await inFlight;
    return { sessionName: full, exists: true };
  }

  const creationPromise = doCreateWppSession(userId, shortName, options).finally(() => {
    sessionCreationPromises.delete(full);
  });

  sessionCreationPromises.set(full, creationPromise);
  return creationPromise;
}



// ===========================
// GET CLIENT
// ===========================
export function getClient(full: string) {
  return clients.get(full);
}

// Invalida cache de IA em memória (preload + estado do chat específico)
export function invalidateChatAICache(userId: number, chatId?: string) {
  chatAICacheLoaded.delete(userId);
  if (chatId) {
    const key = `USER${userId}_${chatId}`;
    chatAILock.delete(key);
    chatAIActivity.delete(key);
  }
}

// Fecha todas as sessões WPP sem apagar tokens (para shutdown gracioso)
export async function shutdownWppClients(): Promise<void> {
  const total = clients.size;
  const closures: Promise<any>[] = [];

  for (const [full, client] of clients.entries()) {
    try {
      const closeResult = client?.close?.();
      if (closeResult && typeof closeResult.then === "function") {
        closures.push(
          closeResult.catch((err: any) => {
            console.warn("Falha ao fechar sessão", full, err?.message || err);
          })
        );
      }
    } catch (err: any) {
      console.warn("Erro ao fechar sessão", full, err?.message || err);
    }
  }

  if (closures.length) {
    await Promise.allSettled(closures);
  }

  console.log(`🔌 WPPConnect: ${total} sessão(ões) finalizadas para shutdown`);
}

async function sendSystemMessage(
  userId: string | number,
  sessionName: string,
  chatId: string,
  text: string
) {
  try {
    const full = `USER${userId}_${sessionName}`;
    const client = clients.get(full);

    if (!client) {
      console.log("ALERTA Não achei client pra enviar mensagem:", full);
      return;
    }

    await withTimeout(client.sendText(chatId, text), WPP_TIMEOUT_MS, "sendText");
  } catch (err) {
    console.log("ERRO Erro ao enviar mensagem do sistema:", err);
  }
}












