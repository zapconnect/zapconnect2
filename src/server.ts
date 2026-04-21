// src/server.ts
import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import http from "http";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import bcrypt from "bcrypt";

import subscriptionRoutes from "./routes/subscription";
import webhookRoutes from "./routes/webhook";
import { subscriptionGuard } from "./middlewares/subscriptionGuard";
import { emailVerifiedMiddleware } from "./middlewares/emailVerifiedMiddleware";
import { sendResetPasswordEmail } from "./utils/sendResetPasswordEmail";
import { sendEmail } from "./utils/sendEmail";

import adminRoutes from "./routes/admin";
import { getChatAI, setChatAI } from "./services/chatAiService";
import {
  type FallbackSettings,
  loadFallbackSettings,
  saveFallbackSettings,
  resetFallbackCache,
} from "./services/fallbackService";
import { stopChatSession } from "./service/google";
import emailVerifyRoutes from "./routes/emailVerify";
import {
  ingestTextSource,
  ingestUrlSource,
  listSources,
  queryKb,
  ingestFileSource,
} from "./services/kbService";
import { summarizeConversationToCrm } from "./services/conversationSummary";
import {
  availableTrialKeys,
  getTrialTemplate,
  saveTrialTemplate,
  listTrialTemplates,
  renderTrialEmailTemplate,
} from "./services/trialTemplates";

import { sendVerifyEmail } from "./utils/sendVerifyEmail";
import { validatePhone } from "./utils/phoneUtils";
import {
  cleanupLocalMediaFile,
  persistMediaBufferToLocalFile,
  releaseMediaPayload,
} from "./utils/mediaUploader";
import {
  SessionRateLimitError,
  assertSessionCanSend,
  getHumanDelay,
  recordSessionSend,
} from "./utils/humanDelay";
import { withTimeout } from "./utils/withTimeout";
import { runChatHistoryCleanup } from "./services/chatHistoryCleaner";
import { getPlanConfig, listPlanConfigs } from "./services/planConfigs";
import {
  DISPATCH_CONSECUTIVE_FAILURE_LIMIT,
  DISPATCH_ERROR_RATE_SAMPLE_SIZE,
  DISPATCH_ERROR_RATE_THRESHOLD,
  classifyDispatchError,
  evaluateDispatchCampaignRisk,
  evaluateDispatchPolicy,
  evaluateDispatchSessionHealth,
  recordDispatchContactEvent,
} from "./services/dispatchPolicy";
import {
  type NumberListValidationResult,
  validateNumberList,
} from "./services/listValidator";
import { setSocketServer } from "./lib/socketEmitter";
import {
  acquireWorkerLock,
  releaseWorkerLock,
  renewWorkerLock,
  WORKER_INSTANCE_ID,
} from "./services/workerLock";
import { logAudit } from "./utils/audit";
import {
  disparoUserLimiter,
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resendEmailLimiter,
} from "./middlewares/rateLimiter";
// setupLogging é chamado em index.ts antes de carregar o servidor

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MAX_CHAT_MESSAGES = Number(process.env.MAX_CHAT_MESSAGES || 500);
const TRIAL_EMAIL_SWEEP_MS = 60 * 60 * 1000; // 1h
const WPP_TIMEOUT_MS = Number(process.env.WPP_TIMEOUT_MS || 12_000);
const GRACEFUL_TIMEOUT_MS = Number(process.env.GRACEFUL_TIMEOUT_MS || 10_000);
const MAX_KB_FILE_BYTES = 10 * 1024 * 1024; // 10MB
let shuttingDown = false;
let appReady = false;

import { getDB, closeDB } from "./database";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ConnectedSessionRow = {
  user_id: number;
  session_name: string;
};

type ScheduleNotificationUser = {
  name: string;
  email: string;
};

async function loadConnectedSessionsByUser(
  db: ReturnType<typeof getDB>,
  userIds: number[]
): Promise<Map<number, string[]>> {
  const uniqueUserIds = Array.from(
    new Set(userIds.filter((id) => Number.isFinite(id)))
  );
  const grouped = new Map<number, string[]>();

  if (!uniqueUserIds.length) return grouped;

  const placeholders = uniqueUserIds.map(() => "?").join(", ");
  const rows = await db.all<ConnectedSessionRow>(
    `
    SELECT user_id, session_name
    FROM sessions
    WHERE status = 'connected'
      AND user_id IN (${placeholders})
    ORDER BY user_id ASC, created_at DESC, id DESC
    `,
    uniqueUserIds
  );

  for (const row of rows) {
    const current = grouped.get(row.user_id) || [];
    current.push(row.session_name);
    grouped.set(row.user_id, current);
  }

  return grouped;
}

async function loadScheduleNotificationUsers(
  db: ReturnType<typeof getDB>,
  userIds: number[]
): Promise<Map<number, ScheduleNotificationUser>> {
  const uniqueUserIds = Array.from(
    new Set(userIds.filter((id) => Number.isFinite(id)))
  );
  const grouped = new Map<number, ScheduleNotificationUser>();

  if (!uniqueUserIds.length) return grouped;

  const placeholders = uniqueUserIds.map(() => "?").join(", ");
  const rows = await db.all<{ id: number; name: string; email: string }>(
    `
    SELECT id, name, email
    FROM users
    WHERE id IN (${placeholders})
    `,
    uniqueUserIds
  );

  for (const row of rows) {
    grouped.set(row.id, {
      name: row.name,
      email: row.email,
    });
  }

  return grouped;
}

async function listConnectedSessions(userId: number): Promise<string[]> {
  const db = getDB();
  const grouped = await loadConnectedSessionsByUser(db, [userId]);
  return grouped.get(userId) || [];
}

function buildSessionCandidates(preferred: string | null | undefined, connected: string[]): string[] {
  const list = [...connected];
  const normPref = (preferred || "").trim();
  if (normPref && list.includes(normPref)) {
    return [normPref, ...list.filter((s) => s !== normPref)];
  }
  return list;
}

// ===============================
// 📦 TIPAGEM DE AGENDAMENTOS
// ===============================
interface ScheduleRow {
  id: number;
  user_id: number;
  numbers: string;
  message: string;
  file: string | null; // caminho relativo no disco (legado: data URL)
  filename: string | null;
  preferred_session?: string | null;
  send_at: number;
  recurrence: "none" | "daily" | "weekly" | "monthly";
  recurrence_end: number | null;
  status: "pending" | "processing" | "sent" | "failed";
  processing_started_at: number | null;
}

import {
  ensureChat,
  createWppSession,
  getQRPathFor,
  deleteWppSession,
  getClient,
  chatAILock,
  enableHumanTemporarily,
  chatHumanLock,
  cancelAIDebounce,
  chatHumanLastActivity,
  chatHumanDuration,
  invalidateChatAICache,
  shutdownWppClients,
} from "./wppManager";
import { simulateFlowRun, simulateWelcomeFlow } from "./wppManager";


import { User } from "./database/types";
import {
  clearAuthCookie,
  createSessionToken,
  ensureFreshUserSession,
  findUserByToken,
  getTokenExpiresAt,
  invalidateUserSession,
  isSessionExpired,
  issueUserSession,
  setAuthCookie,
} from "./utils/authSession";


const app = express();
export function markAppReady(flag = true) {
  appReady = flag;
}

// ===============================
// 🧩 Utilitário de template simples para mensagens
// ===============================
type PersonalizedContact = {
  number: string;
  message?: string;
  vars?: Record<string, string>;
};

type ScheduleItemLog = {
  number: string;
  status: "sent" | "error";
  error?: string;
  sentAt: number;
};

function uniqueWarnings(warnings: string[] = []) {
  return Array.from(new Set(warnings.filter(Boolean)));
}

function getCampaignPauseReason(progress: {
  sessionName: string;
  processed: number;
  failures: number;
  consecutiveFailures: number;
}) {
  if (progress.consecutiveFailures >= DISPATCH_CONSECUTIVE_FAILURE_LIMIT) {
    return `Campanha pausada na sessão ${progress.sessionName} após ${progress.consecutiveFailures} falhas consecutivas.`;
  }

  if (
    progress.processed >= DISPATCH_ERROR_RATE_SAMPLE_SIZE &&
    progress.failures / Math.max(progress.processed, 1) >= DISPATCH_ERROR_RATE_THRESHOLD
  ) {
    return `Campanha pausada na sessão ${progress.sessionName} por taxa de erro elevada.`;
  }

  return null;
}

function isRetryableDispatchPolicyBlock(reason: string, skipCodes: string[] = []) {
  const normalized = String(reason || "").toLowerCase();
  return (
    normalized.includes("envios s") ||
    normalized.includes("limite diario seguro") ||
    normalized.includes("limite seguro atual") ||
    normalized.includes("aquecimento") ||
    normalized.includes("fase de aquecimento") ||
    skipCodes.includes("cooldown")
  );
}

async function recordSkippedDispatchContacts(
  db: DBClient,
  input: {
    userId: number;
    campaignKind: "broadcast" | "schedule";
    campaignRef: string;
    skips: { number: string; code: string; reason: string }[];
  }
) {
  for (const skip of input.skips) {
    await recordDispatchContactEvent(
      {
        userId: input.userId,
        campaignKind: input.campaignKind,
        campaignRef: input.campaignRef,
        phone: skip.number,
        status: "skipped",
        errorCode: skip.code,
        errorMessage: skip.reason,
      },
      db
    );
  }
}

const normalizeVars = (input: any): Record<string, string> => {
  const out: Record<string, string> = {};
  const source = typeof input?.vars === "object" && input?.vars !== null ? input.vars : input;

  if (source && typeof source === "object") {
    Object.entries(source).forEach(([key, val]) => {
      if (["number", "message", "vars"].includes(key)) return;
      if (val === undefined || val === null) return;
      const strVal = typeof val === "string" ? val : String(val);
      const normKey = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
      if (normKey) out[normKey] = strVal;
    });
  }

  return out;
};

const sanitizeContactPayload = (raw: any): PersonalizedContact | null => {
  const { ok, sanitized } = validatePhone(raw?.number);
  if (!ok) return null;
  const contact: PersonalizedContact = { number: sanitized };

  if (raw?.message !== undefined) contact.message = String(raw.message);
  const vars = normalizeVars(raw);
  if (Object.keys(vars).length) contact.vars = vars;

  return contact;
};

const buildContactsFromPayload = (contactsArr: any[]): PersonalizedContact[] =>
  Array.isArray(contactsArr)
    ? contactsArr.map(sanitizeContactPayload).filter(Boolean) as PersonalizedContact[]
    : [];

const buildBroadcastContactsFromBody = (body: any): PersonalizedContact[] => {
  const contactsArr: any[] = Array.isArray(body?.contacts) ? body.contacts : [];
  if (contactsArr.length) {
    return buildContactsFromPayload(contactsArr);
  }

  const numbersArr: any[] = Array.isArray(body?.numbers) ? body.numbers : [];
  if (numbersArr.length) {
    return numbersArr
      .map((entry) => {
        const { ok, sanitized } = validatePhone(entry);
        return ok ? { number: sanitized, message: body?.message } : null;
      })
      .filter(Boolean) as PersonalizedContact[];
  }

  const { ok, sanitized } = validatePhone(body?.number);
  if (!ok) return [];
  return [{ number: sanitized, message: body?.message }];
};

const buildRawNumbersFromBody = (body: any): string[] => {
  const contactsArr: any[] = Array.isArray(body?.contacts) ? body.contacts : [];
  if (contactsArr.length) {
    return contactsArr.map((entry) => String(entry?.number ?? "")).filter(Boolean);
  }

  const numbersArr: any[] = Array.isArray(body?.numbers) ? body.numbers : [];
  if (numbersArr.length) {
    return numbersArr.map((entry) => String(entry ?? "")).filter(Boolean);
  }

  if (body?.number !== undefined && body?.number !== null) {
    return [String(body.number)];
  }

  return [];
};

type LiveListValidation = {
  sessionName: string | null;
  validation: NumberListValidationResult | null;
  warnings: string[];
};

function findLiveClientSession(userId: number, candidates: string[]) {
  for (const shortName of candidates) {
    const client = getClient(`USER${userId}_${shortName}`);
    if (client) {
      return {
        sessionName: shortName,
        client,
      };
    }
  }

  return {
    sessionName: null,
    client: null,
  };
}

async function runListQualityValidation(input: {
  userId: number;
  rawNumbers: string[];
  preferredSession?: string | null;
  connectedSessions?: string[];
  unavailableWarning?: string;
}): Promise<LiveListValidation> {
  const warnings: string[] = [];
  const connected = Array.isArray(input.connectedSessions)
    ? input.connectedSessions
    : await listConnectedSessions(input.userId);

  if (!connected.length) {
    if (input.unavailableWarning) warnings.push(input.unavailableWarning);
    return {
      sessionName: null,
      validation: null,
      warnings,
    };
  }

  const candidates = buildSessionCandidates(input.preferredSession || null, connected);
  const live = findLiveClientSession(input.userId, candidates);

  if (!live.client || !live.sessionName) {
    if (input.unavailableWarning) warnings.push(input.unavailableWarning);
    return {
      sessionName: null,
      validation: null,
      warnings,
    };
  }

  const validation = await validateNumberList(live.client, input.rawNumbers);
  return {
    sessionName: live.sessionName,
    validation,
    warnings: uniqueWarnings([...warnings, ...validation.warnings]),
  };
}

// =======================================================
// 📨 Trial — emails e onboarding
// =======================================================
type TrialFlags = {
  trial_email_day1_sent?: number;
  trial_email_day3_sent?: number;
  trial_email_day6_sent?: number;
  trial_email_last_sent?: number;
  trial_started_at?: number | null;
};

function daysDiffRounded(from: number, to: number) {
  return Math.floor((to - from) / (24 * 60 * 60 * 1000));
}

async function sendTrialEmail(
  user: any,
  subject: string,
  html: string,
  flagColumn: keyof TrialFlags
) {
  try {
    await sendEmail(user.email, subject, html);
    const db = getDB();
    await db.run(`UPDATE users SET ${flagColumn} = 1 WHERE id = ?`, [user.id]);
    console.log(`📧 Trial email ${flagColumn} enviado para ${user.email}`);
  } catch (err) {
    console.error(`Erro ao enviar email ${flagColumn}:`, err);
  }
}

async function runTrialEmailSweep() {
  if (shuttingDown) return;
  let db;
  try {
    db = getDB();
  } catch {
    // DB ainda não inicializado — tenta de novo no próximo ciclo
    return;
  }

  try {
    const now = Date.now();
    const rows = await db.all(
      `
      SELECT id, name, email, plan_expires_at, subscription_status,
             trial_started_at,
             trial_email_day1_sent, trial_email_day3_sent,
             trial_email_day6_sent, trial_email_last_sent
      FROM users
      WHERE subscription_status = 'trial'
        AND plan_expires_at IS NOT NULL
        AND plan_expires_at > ?
      `,
      [now - 24 * 60 * 60 * 1000]
    );

    for (const user of rows) {
      const started = Number(user.trial_started_at || user.plan_expires_at - 7 * 24 * 60 * 60 * 1000);
      const daysElapsed = daysDiffRounded(started, now) + 1;
      const daysLeft = Math.max(0, Math.ceil((Number(user.plan_expires_at) - now) / (24 * 60 * 60 * 1000)));

      // Dia 1
      if (daysElapsed >= 1 && !user.trial_email_day1_sent) {
        const tpl = await getTrialTemplate("trial_day1");
        const mail = renderTrialEmailTemplate({
          key: "trial_day1",
          subject: tpl.subject,
          body: tpl.body,
          baseUrl: BASE_URL,
          name: user.name,
        });
        await sendTrialEmail(user, mail.subject, mail.html, "trial_email_day1_sent");
        continue;
      }

      // Dia 3
      if (daysElapsed >= 3 && !user.trial_email_day3_sent) {
        const tpl = await getTrialTemplate("trial_day3");
        const mail = renderTrialEmailTemplate({
          key: "trial_day3",
          subject: tpl.subject,
          body: tpl.body,
          baseUrl: BASE_URL,
          name: user.name,
        });
        await sendTrialEmail(user, mail.subject, mail.html, "trial_email_day3_sent");
        continue;
      }

      // Dia 6
      if (daysElapsed >= 6 && !user.trial_email_day6_sent) {
        const tpl = await getTrialTemplate("trial_day6");
        const mail = renderTrialEmailTemplate({
          key: "trial_day6",
          subject: tpl.subject,
          body: tpl.body,
          baseUrl: BASE_URL,
          name: user.name,
        });
        await sendTrialEmail(user, mail.subject, mail.html, "trial_email_day6_sent");
        continue;
      }

      // Último dia (<=1 dia restante)
  if (daysLeft <= 1 && !user.trial_email_last_sent) {
        const tpl = await getTrialTemplate("trial_last");
        const mail = renderTrialEmailTemplate({
          key: "trial_last",
          subject: tpl.subject,
          body: tpl.body,
          baseUrl: BASE_URL,
          name: user.name,
        });
        await sendTrialEmail(user, mail.subject, mail.html, "trial_email_last_sent");
      }
    }
  } catch (err) {
    console.error("Erro no sweep de trial:", err);
  }
}

function startTrialEmailCron() {
  runTrialEmailSweep();
  setInterval(runTrialEmailSweep, TRIAL_EMAIL_SWEEP_MS);
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_UPLOAD_MIMES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
]);

type SanitizedFile = {
  dataUrl: string;
  base64: string;
  buffer: Buffer;
  mime: string;
  filename: string;
};

type PreparedMediaFile = {
  content: string;
  filename: string;
  cleanupPath?: string | null;
};

type DBClient = ReturnType<typeof getDB>;

const detectMimeFromBuffer = (buf: Buffer): string | null => {
  if (buf.length < 4) return null;

  const header4 = buf.subarray(0, 4);
  if (header4[0] === 0xff && header4[1] === 0xd8 && header4[2] === 0xff) return "image/jpeg";
  if (header4.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (header4.equals(Buffer.from([0x47, 0x49, 0x46, 0x38]))) return "image/gif";
  if (header4.equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return "application/pdf";

  if (header4.equals(Buffer.from([0x52, 0x49, 0x46, 0x46]))) {
    const subtype = buf.subarray(8, 12).toString("ascii");
    if (subtype === "WEBP") return "image/webp";
    if (subtype === "WAVE") return "audio/wav";
  }

  if (buf.subarray(0, 3).toString("ascii") === "ID3" || (header4[0] === 0xff && (header4[1] & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }

  if (buf.subarray(0, 4).equals(Buffer.from([0x4f, 0x67, 0x67, 0x53]))) return "audio/ogg";
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (header4[0] === 0x50 && header4[1] === 0x4b) return "application/zip";

  return null;
};

const guessMimeFromFilename = (filename: string): string | null => {
  const ext = path.extname(filename || "").toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".zip":
      return "application/zip";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return null;
  }
};

const KB_ALLOWED_BINARY_MIMES = new Set<string>(["application/pdf"]);
const KB_ALLOWED_TEXT_MIMES = new Set<string>(["text/plain", "text/csv"]);
const KB_ALLOWED_TEXT_EXTENSIONS = new Set<string>([
  ".txt",
  ".csv",
  ".md",
  ".json",
  ".xml",
  ".html",
  ".htm",
]);

const normalizeBase64Payload = (input: string) => {
  const raw = String(input || "").trim();
  const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
  return {
    declaredMime: match?.[1]?.toLowerCase() || null,
    base64: String(match?.[2] || raw).replace(/\s+/g, ""),
  };
};

const estimateBase64DecodedBytes = (rawBase64: string) => {
  const normalized = String(rawBase64 || "").replace(/\s+/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
};

const isProbablyUtf8TextBuffer = (buffer: Buffer) => {
  if (!buffer.length) return false;

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 0x00) return false;
    const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isHighByte = byte >= 0x80;
    if (!isAllowedControl && !isPrintableAscii && !isHighByte) {
      suspicious += 1;
    }
  }

  if (suspicious / sample.length > 0.1) return false;

  const decoded = sample.toString("utf-8");
  const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
  return replacementCount / Math.max(decoded.length, 1) <= 0.02;
};

const decodeKbUploadBase64 = (fileBase64: string, fileName: string) => {
  const { declaredMime, base64 } = normalizeBase64Payload(fileBase64);
  if (!base64) {
    throw new Error("Arquivo base64 inválido");
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error("Conteúdo base64 inválido");
  }

  const estimatedBytes = estimateBase64DecodedBytes(base64);
  if (estimatedBytes > MAX_KB_FILE_BYTES) {
    throw new Error(
      `Arquivo excede o limite de 10MB (estimado: ${Math.ceil(estimatedBytes / 1024 / 1024)}MB)`
    );
  }

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    throw new Error("Arquivo vazio");
  }
  if (buffer.byteLength > MAX_KB_FILE_BYTES) {
    throw new Error(
      `Arquivo excede o limite de 10MB (${Math.ceil(buffer.byteLength / 1024 / 1024)}MB)`
    );
  }

  const detectedMime = detectMimeFromBuffer(buffer);
  const guessedMime = guessMimeFromFilename(fileName);
  const ext = path.extname(String(fileName || "")).toLowerCase();
  const isAllowedTextFile = KB_ALLOWED_TEXT_EXTENSIONS.has(ext) && isProbablyUtf8TextBuffer(buffer);

  if (detectedMime) {
    if (!KB_ALLOWED_BINARY_MIMES.has(detectedMime) && !KB_ALLOWED_TEXT_MIMES.has(detectedMime)) {
      throw new Error("Tipo de arquivo não suportado para base de conhecimento");
    }
    if (KB_ALLOWED_BINARY_MIMES.has(detectedMime) && guessedMime && guessedMime !== detectedMime) {
      throw new Error("Extensão do arquivo não corresponde ao conteúdo enviado");
    }
  } else if (!isAllowedTextFile) {
    throw new Error("Tipo de arquivo não suportado para base de conhecimento");
  }

  if (
    declaredMime &&
    detectedMime &&
    declaredMime !== detectedMime &&
    !(KB_ALLOWED_TEXT_MIMES.has(declaredMime) && KB_ALLOWED_TEXT_MIMES.has(detectedMime))
  ) {
    throw new Error("Tipo declarado do arquivo não corresponde ao conteúdo enviado");
  }

  return buffer;
};

const sanitizeIncomingFile = (input: {
  dataUrl?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
}): SanitizedFile => {
  const candidate = input.dataUrl ?? (input.mimetype && input.base64 ? `data:${input.mimetype};base64,${input.base64}` : "");
  const match = typeof candidate === "string" ? candidate.match(/^data:([^;]+);base64,(.+)$/i) : null;
  if (!match) {
    throw new Error("Arquivo inválido");
  }

  const declaredMime = match[1].toLowerCase();
  const rawBase64 = match[2];

  let buffer: Buffer;
  try {
    buffer = Buffer.from(rawBase64, "base64");
  } catch {
    throw new Error("Base64 inválido");
  }

  if (!buffer.length) throw new Error("Arquivo vazio");
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error("Arquivo excede limite de 15MB");

  const detected = detectMimeFromBuffer(buffer);
  const finalMime = detected ?? declaredMime;

  if (!ALLOWED_UPLOAD_MIMES.has(finalMime)) {
    throw new Error("Tipo de arquivo não permitido");
  }

  const normalizedBase64 = buffer.toString("base64");

  return {
    dataUrl: `data:${finalMime};base64,${normalizedBase64}`,
    base64: normalizedBase64,
    buffer,
    mime: finalMime,
    filename: input.filename || "arquivo",
  };
};

// ===============================
// 💾 Armazenamento local de arquivos de agendamento
// ===============================
const DISPATCH_FILES_ROOT = path.join(process.cwd(), "dispatch_uploads");
const SCHEDULE_FILES_ROOT = path.join(process.cwd(), "schedule_uploads");
const SCHEDULE_STORAGE_DRIVER = (process.env.SCHEDULE_STORAGE_DRIVER || "local")
  .trim()
  .toLowerCase();

const isDataUrl = (val: unknown): val is string => typeof val === "string" && /^data:[^;]+;base64,/.test(String(val));
const isLocalScheduleStorage = () =>
  !SCHEDULE_STORAGE_DRIVER || ["local", "filesystem", "fs"].includes(SCHEDULE_STORAGE_DRIVER);

const sanitizeScheduleFilename = (name: string) => {
  const base = path.basename(name || "arquivo");
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_");
  // evita caminhos gigantes que atrapalham o FS
  return cleaned.slice(-180) || "arquivo";
};

const toRelativeSchedulePath = (absPath: string) =>
  path.relative(process.cwd(), absPath).replace(/\\/g, "/");

const resolveSchedulePath = (storedPath: string) =>
  path.isAbsolute(storedPath) ? storedPath : path.join(process.cwd(), storedPath);

const persistScheduleFile = (userId: number, file: SanitizedFile): string => {
  const dir = path.join(SCHEDULE_FILES_ROOT, String(userId));
  fs.mkdirSync(dir, { recursive: true });

  const safeName = sanitizeScheduleFilename(file.filename);
  const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeName}`;
  const absPath = path.join(dir, unique);

  fs.writeFileSync(absPath, file.buffer);
  return toRelativeSchedulePath(absPath);
};

const prepareDispatchFileForSend = (
  userId: number,
  file: SanitizedFile
): PreparedMediaFile => {
  try {
    const absPath = persistMediaBufferToLocalFile(DISPATCH_FILES_ROOT, userId, file);
    return {
      content: absPath,
      filename: file.filename,
      cleanupPath: absPath,
    };
  } finally {
    releaseMediaPayload(file);
  }
};

const loadScheduleFileFromPath = (storedPath: string, filename?: string): PreparedMediaFile | null => {
  try {
    const abs = resolveSchedulePath(storedPath);
    if (!fs.existsSync(abs)) return null;

    return {
      content: abs,
      filename: filename || path.basename(abs),
    };
  } catch (err) {
    console.error("⚠️ Erro ao carregar arquivo de agendamento:", err);
    return null;
  }
};

const deleteScheduleFileIfUnused = async (db: DBClient, storedPath?: string | null) => {
  try {
    if (!storedPath || isDataUrl(storedPath)) return;
    const refCount = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM schedules WHERE file = ?`,
      [storedPath]
    );
    if ((refCount?.total || 0) > 1) return;

    const abs = resolveSchedulePath(storedPath);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
    }
  } catch (err) {
    console.warn("⚠️ Não foi possível remover arquivo de agendamento:", err);
  }
};

const ensureScheduleFileOnDisk = async (
  db: DBClient,
  row: ScheduleRow
): Promise<{ file: PreparedMediaFile | null; storedPath: string | null }> => {
  if (!row.file) return { file: null, storedPath: null };
  const safeFilename = row.filename || "arquivo";

  // Migração automática de registros antigos em base64
  if (isDataUrl(row.file)) {
    try {
      const safe = sanitizeIncomingFile({ dataUrl: row.file, filename: safeFilename });
      const storedPath = persistScheduleFile(row.user_id, safe);
      await db.run(`UPDATE schedules SET file = ?, filename = ? WHERE id = ?`, [storedPath, safe.filename, row.id]);
      const prepared: PreparedMediaFile = {
        content: resolveSchedulePath(storedPath),
        filename: safe.filename,
      };
      releaseMediaPayload(safe);
      return { file: prepared, storedPath };
    } catch (err) {
      console.error("⚠️ Falha ao migrar arquivo de agendamento:", err);
      return { file: null, storedPath: null };
    }
  }

  const loaded = loadScheduleFileFromPath(row.file, row.filename || undefined);
  return { file: loaded, storedPath: row.file };
};

const validateScheduleStorageSetup = () => {
  const storagePath = SCHEDULE_FILES_ROOT;

  if (!isLocalScheduleStorage()) {
    console.warn(
      `⚠️ SCHEDULE_STORAGE_DRIVER="${SCHEDULE_STORAGE_DRIVER}" ainda não é suportado neste build. O sistema continuará usando disco local em ${storagePath}.`
    );
  }

  try {
    fs.mkdirSync(storagePath, { recursive: true });
    fs.accessSync(storagePath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    console.error(
      `❌ Falha ao preparar o diretório de mídia dos agendamentos (${storagePath}). Uploads e disparos com arquivo podem falhar.`,
      err
    );
    return;
  }

  console.warn(
    `⚠️ Agendamentos com mídia estão usando armazenamento local em ${storagePath}. Em containers com disco efêmero, esses arquivos podem sumir após restart/deploy. Monte volume persistente ou mova para storage externo antes de produção.`
  );
};

validateScheduleStorageSetup();

const buildContactsFromStored = (raw: any, baseMessage?: string): PersonalizedContact[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        const { ok, sanitized } = validatePhone(item);
        if (!ok) return null;
        return { number: sanitized, message: baseMessage };
      }
      const contact = sanitizeContactPayload(item);
      if (contact && contact.message === undefined && baseMessage !== undefined) {
        contact.message = baseMessage;
      }
      return contact;
    })
    .filter(Boolean) as PersonalizedContact[];
};

const renderTemplate = (template: string, contact?: PersonalizedContact): string => {
  if (!template) return "";
  const now = new Date();
  const dataHoje = now.toLocaleDateString("pt-BR");
  const horaAgora = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const vars: Record<string, string> = {
    numero: contact?.number || "",
    number: contact?.number || "",
    nome: contact?.vars?.nome || contact?.vars?.name || "",
    name: contact?.vars?.nome || contact?.vars?.name || "",
    pedido: contact?.vars?.pedido || contact?.vars?.order || "",
    order: contact?.vars?.pedido || contact?.vars?.order || "",
    data: dataHoje,
    data_atual: dataHoje,
    hoje: dataHoje,
    hora: horaAgora,
    horario: horaAgora,
    time: horaAgora,
    date: dataHoje,
    ...(contact?.vars || {}),
  };

  return template.replace(/{{\s*([\w.-]+)\s*}}/gi, (_match, keyRaw) => {
    const key = String(keyRaw || "").toLowerCase();
    return vars[key] !== undefined ? String(vars[key]) : "";
  });
};

// ⚠️ CORS com cookies (importante para deploy)
app.use(
  cors({
    origin: true,            // Aceita qualquer domínio
    credentials: true,       // Permite cookies
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===============================
// 🔎 Health / Readiness
// ===============================
app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    uptime: Math.round(process.uptime() * 1000),
    shuttingDown,
  });
});

app.get("/ready", async (_req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ ok: false, status: "shutting_down" });
  }
  if (!appReady) {
    return res.status(503).json({ ok: false, status: "starting" });
  }

  try {
    const db = getDB();
    await db.get("SELECT 1 as ok");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Readiness check falhou:", err);
    return res.status(503).json({ ok: false, status: "db_unreachable" });
  }
});
// ⚠️ WEBHOOK STRIPE — RAW BODY (OBRIGATÓRIO)
// ⚠️ WEBHOOK STRIPE — RAW BODY (OBRIGATÓRIO)
app.use(
  "/webhook/stripe",
  express.raw({ type: "application/json" })
);

// =======================================
// 🌐 Middlewares globais
// =======================================
app.use(cookieParser());
app.use("/", emailVerifyRoutes);
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use("/webhook", webhookRoutes);

// ⚠️ OBRIGATÓRIO: antes das rotas normais
app.use("/subscription", subscriptionRoutes);
app.use("/admin", authMiddleware, adminRoutes);

// ===============================
// 📊 STATS DO PAINEL
// ===============================
app.get("/api/painel/stats", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const now = Date.now();

    // ✅ Sessões ativas (dado confiável)
    const sessionsAtivas = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM sessions
       WHERE user_id = ? AND status = 'connected'`,
      [user.id]
    );

    // ✅ Total de sessões (para card "Total de sessões")
    const totalSessoes = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM sessions WHERE user_id = ?`,
      [user.id]
    );

    // ✅ Clientes no CRM
    const totalClientes = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM crm WHERE user_id = ?`,
      [user.id]
    );

    // ✅ Agendamentos pendentes futuros
    const agendamentos = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM schedules
       WHERE user_id = ? AND status = 'pending' AND send_at > ?`,
      [user.id, now]
    );

    // ✅ Agendamentos enviados (histórico)
    const agendamentosEnviados = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM schedules
       WHERE user_id = ? AND status = 'sent'`,
      [user.id]
    );

    // ✅ Uso de IA no mês (vem direto do user)
    const iaUsado = Number(user.ia_messages_used) || 0;

    return res.json({
      ok: true,
      sessionsAtivas:      sessionsAtivas?.total      ?? 0,
      totalSessoes:        totalSessoes?.total         ?? 0,
      totalClientes:       totalClientes?.total        ?? 0,
      agendamentos:        agendamentos?.total         ?? 0,
      agendamentosEnviados: agendamentosEnviados?.total ?? 0,
      iaUsado,
    });
  } catch (err) {
    console.error("❌ Erro stats painel:", err);
    return res.json({
      ok: false,
      sessionsAtivas: 0, totalSessoes: 0,
      totalClientes: 0, agendamentos: 0,
      agendamentosEnviados: 0, iaUsado: 0
    });
  }
});

app.get(
  "/painel",
  authMiddleware,
  subscriptionGuard,
  async (req: Request, res: Response) => {
    const user = (req as any).user as User & { plan?: string };
    const db = getDB();

    const sessions = await db.all(
      `SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC`,
      [user.id]
    );

    const API_URL =
      process.env.API_URL || `${req.protocol}://${req.get("host")}`;

    res.render("painel", { user, sessions, API_URL });
  }
);

// 📦 Servir frontend estático (CSS, JS, imagens)
// 🔄 Evita cache agressivo nos assets para refletir mudanças imediatas em ambiente de desenvolvimento.
app.use((req, res, next) => {
  if (req.path.startsWith("/js/") || req.path.startsWith("/css/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

/* ===========================
   Minificação simples de CSS em produção
=========================== */
const cssCache = new Map<string, { mtime: number; data: Buffer }>();
app.get(/.*\.css$/, (req, res, next) => {
  if (process.env.NODE_ENV !== "production") return next();
  try {
    const filePath = path.join(process.cwd(), "public", req.path.replace(/^\//, ""));
    const stat = fs.statSync(filePath);
    const cached = cssCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      res.type("text/css").send(cached.data);
      return;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const min = raw
      .replace(/\/\*[^!*][\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*([{}:;,>~+])\s*/g, "$1")
      .replace(/;}/g, "}")
      .trim();
    const buf = Buffer.from(min, "utf8");
    cssCache.set(filePath, { mtime: stat.mtimeMs, data: buf });
    res.type("text/css").send(buf);
  } catch {
    return next();
  }
});

app.use(express.static(path.join(process.cwd(), "public")));
// 📸 Servir QR Codes gerados pelo WPPConnect
app.use("/qr", express.static(path.join(process.cwd(), "qr")));

// =======================================
// 🎨 EJS Configurado
// =======================================
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

// =======================================
// 🔌 Servidor + Socket.io
// =======================================
export const server = http.createServer(app);
export const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB — permite arquivos grandes via socket
});
setSocketServer(io);

const parseCookies = (cookieHeader: string | undefined) => {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k, decodeURIComponent(v.join("="))];
    })
  );
};

// Autenticação via cookie (mesma lógica do authMiddleware)
io.use(async (socket, next) => {
  try {
    const cookies = parseCookies(socket.handshake.headers.cookie as string | undefined);
    const token = cookies?.token;
    if (!token) return next(new Error("unauthorized"));

    const user = await findUserByToken(token);
    if (!user || isSessionExpired(user)) return next(new Error("unauthorized"));

    socket.data.userId = user.id;
    next();
  } catch (err) {
    next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  console.log("🔌 Socket conectado:", socket.id);
  const uid = socket.data.userId as number | undefined;
  if (uid) socket.join(`user:${uid}`);

  socket.on("crm:changed_local", () => {
    if (!uid) return;
    io.to(`user:${uid}`).emit("crm:changed", { type: "sync" });
  });

  socket.on("chat_ai_state_request", async (chatId) => {
    const userId = socket.data.userId as number | undefined;
    if (!userId || !chatId) return;

    const state = await getChatAI(userId, chatId);
    socket.emit("chat_ai_state", { chatId, state });
  });

  socket.on("chat_ai_off", async (chatId) => {
    const userId = socket.data.userId as number | undefined;
    if (!userId) return;

    await setChatAI(userId, chatId, false);

    const key = `USER${userId}_${chatId}`;
    chatAILock.set(key, false);
    invalidateChatAICache(userId, chatId);

    io.to(`user:${userId}`).emit("chat_ai_state", { chatId, state: false });
  });


  socket.on("chat_ai_on", async (chatId) => {
    const userId = socket.data.userId as number | undefined;
    if (!userId) return;

    await setChatAI(userId, chatId, true);

    const key = `USER${userId}_${chatId}`;
    chatAILock.set(key, true);
    invalidateChatAICache(userId, chatId);

    io.to(`user:${userId}`).emit("chat_ai_state", { chatId, state: true });
  });

  socket.on("admin_send_message", async ({ chatId, body, file, filename, mimetype }) => {
    try {
      const userId = socket.data.userId as number | undefined;
      if (!userId || !chatId) return;
      if (!body && !file) return;

      const db = getDB();

      const session = await db.get(
        `SELECT session_name
         FROM sessions
         WHERE user_id = ? AND status = 'connected'
         LIMIT 1`,
        [userId]
      );

      if (!session) {
        console.log("❌ Nenhuma sessão conectada para", userId);
        return;
      }

      const full = `USER${userId}_${session.session_name}`;
      const client = getClient(full);

      if (!client) {
        console.log("❌ Cliente WhatsApp não encontrado:", full);
        return;
      }

      // 📎 ENVIO DE ARQUIVO
      if (file && mimetype && filename) {
        const safeFile = sanitizeIncomingFile({
          base64: file,
          mimetype,
          filename,
        });
        await withTimeout(client.sendFile(chatId, safeFile.dataUrl, safeFile.filename, body || ""), WPP_TIMEOUT_MS, "sendFile");

        io.to(socket.id).emit("newMessage", {
          chatId,
          body: safeFile.base64,
          mimetype: safeFile.mime,
          isMedia: true,
          fromMe: true,
          _isFromMe: true,
          timestamp: Date.now()
        });
        return;
      }

      // 💬 ENVIO DE TEXTO
      await withTimeout(client.sendText(chatId, body), WPP_TIMEOUT_MS, "sendText");

      io.to(socket.id).emit("newMessage", {
        chatId,
        body,
        fromMe: true,
        _isFromMe: true,
        timestamp: Date.now()
      });

    } catch (err) {
      console.error("❌ Erro ao enviar mensagem do admin:", err);
    }
  });

  socket.on("chat_human_state", async (data: any) => {
    const { chatId, state, sessionName } = data;
    const userId = socket.data.userId as number | undefined;
    if (!userId || !chatId || !sessionName) return;

    const fullKey = `USER${userId}_${sessionName}`;
    const chatKey = `${fullKey}::${chatId}`;

    if (state === true) {
      // 👤 ativa humano com duração configurável
      // durationMs: número em ms ou null (sem limite)
      const durationMs = (typeof data.durationMs === "number")
        ? data.durationMs
        : (data.durationMs === null ? null : 5 * 60 * 1000);

      enableHumanTemporarily(userId, sessionName, chatId, durationMs);

      // 🔥 cancela IA já armada
      cancelAIDebounce(chatKey);

      await logAudit("human_mode_on", userId, "chat", chatId, {
        sessionName,
        durationMs,
      });

    } else {
      const humanKey = `${fullKey}::${chatId}`;

      chatHumanLock.set(humanKey, false);
      chatHumanLastActivity.delete(humanKey);

      cancelAIDebounce(chatKey);

      io.to(`user:${userId}`).emit("human_state_changed", {
        chatId,
        userId,
        sessionName,
        state: false,
      });

      // 📄 Resumo automático da conversa salvo como nota no CRM (off-thread + timeout)
      setImmediate(() => {
        const timer = setTimeout(() => {
          console.warn("Resumo de conversa expirou após 15s", { chatId, userId });
        }, 15000).unref();

        Promise.race([
          summarizeConversationToCrm({
            userId: Number(userId),
            sessionName,
            chatId,
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 15000)),
        ])
          .catch((err: any) => console.error("Erro ao resumir conversa (assíncrono):", err))
          .finally(() => clearTimeout(timer));
      });

      await logAudit("human_mode_off", userId, "chat", chatId, {
        sessionName,
      });
    }

  });

  /**
   * =========================================================
   * 📋 LISTAR CHATS DO WHATSAPP (SIDEBAR)
   * =========================================================
   */
  socket.on("listar_chats", async () => {
    try {
      const userId = socket.data.userId as number | undefined;
      if (!userId) {
        socket.emit("lista_chats", []);
        return;
      }

      const db = getDB();

      // 🔎 Buscar sessão conectada
      const session = await db.get(
        `SELECT session_name 
         FROM sessions 
         WHERE user_id = ? AND status = 'connected'
         LIMIT 1`,
        [userId]
      );

      if (!session) {
        socket.emit("lista_chats", []);
        return;
      }

      const full = `USER${userId}_${session.session_name}`;
      const client = getClient(full);

      if (!client) {
        socket.emit("lista_chats", []);
        return;
      }

      // 🔥 Chats reais do WhatsApp
      const allChats = await client.listChats();

      // 🖼️ Mapa de avatares já salvos no CRM (phone -> url)
      const avatarMap = new Map<string, string>();
      try {
        const phones = Array.from(
          new Set(
            allChats
              .filter((c: any) => c.id?._serialized && !c.id._serialized.endsWith("@g.us"))
              .map((c: any) => c.id?.user || c.id?._serialized.replace(/@.*/, ""))
              .filter(Boolean)
          )
        );

        if (phones.length > 0) {
          const placeholders = phones.map(() => "?").join(",");
          const rows = await db.all<{ phone: string; avatar: string | null }>(
            `SELECT phone, avatar FROM crm WHERE user_id = ? AND phone IN (${placeholders})`,
            [userId, ...phones]
          );
          rows.forEach((r) => {
            if (r.avatar) avatarMap.set(r.phone, r.avatar);
          });
        }
      } catch (err) {
        console.warn("⚠️ Não foi possível buscar avatares do CRM:", err);
      }

      const chats = allChats
        .filter((c: any) => c.id?._serialized) // só garante id válido
        .map((c: any) => {
          const chatId = c.id._serialized;
          const phone = c.id?.user || chatId.replace(/@.*/, "");

          const fullKey = `USER${userId}_${session.session_name}`;
          const key = `${fullKey}::${chatId}`;

          const isHuman = chatHumanLock.get(key) === true;

          const last = Number(chatHumanLastActivity.get(key) || 0);

          return {
            id: chatId,
            name:
              c.name ||
              c.formattedName ||
              c.contact?.pushname ||
              c.contact?.name ||
              (c.isGroup ? c.id.user : c.id.user),

            isGroup: chatId.endsWith("@g.us"),

            // 👤 modo humano real
            human: isHuman,

            // 🤖 IA por chat (você pode melhorar depois)
            ai: true,

            // ⏱ expire real usando duração configurada pelo operador
            expire: (() => {
              if (!isHuman) return null;
              const fullKey2 = `USER${userId}_${session.session_name}`;
              const humanKey2 = `${fullKey2}::${chatId}`;
              const dur = chatHumanDuration.get(humanKey2);
              if (dur === null) return null; // sem limite
              const duration = dur ?? 5 * 60 * 1000;
              return (last || Date.now()) + duration;
            })(),

            // 🖼️ avatar prioriza CRM, depois thumbnail do WhatsApp (se disponível)
            avatar:
              avatarMap.get(phone) ||
              c.contact?.profilePicThumbObj?.eurl ||
              c.profilePicThumbObj?.eurl ||
              null,
          };
        });


      socket.emit("lista_chats", chats);

    } catch (err) {
      console.error("❌ Erro ao listar chats:", err);
      socket.emit("lista_chats", []);
    }
  });

  /**
   * =========================================================
   * 💬 ABRIR CHAT + CARREGAR HISTÓRICO REAL
   * =========================================================
   */
  socket.on("abrir_chat", async (chatId: string) => {
    try {
      const userId = socket.data.userId as number | undefined;
      if (!userId || !chatId) {
      socket.emit("mensagens_chat", { chatId, messages: [] });
      return;
    }
    const chatIdClean = chatId.includes("@") ? chatId : `${chatId}@c.us`;

    const db = getDB();

      // 🔎 Buscar sessão conectada
      const session = await db.get(
        `SELECT session_name 
       FROM sessions 
       WHERE user_id = ? AND status = 'connected'
       LIMIT 1`,
        [userId]
      );

      if (!session) {
        socket.emit("mensagens_chat", { chatId, messages: [] });
        return;
      }

      const full = `USER${userId}_${session.session_name}`;
      const client = getClient(full);

      if (!client) {
        socket.emit("mensagens_chat", { chatId, messages: [] });
        return;
      }

      // ==================================================
      // ✅ ABRIR CHAT (SEM loadEarlierMsgs)
      // ==================================================
      let messages: any[] = [];

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await withTimeout(client.openChat(chatIdClean), WPP_TIMEOUT_MS, "openChat");

          // ⏳ pequeno delay para WhatsApp carregar mensagens em memória
          await sleep(500);

          // ==================================================
          // 📥 BUSCAR MENSAGENS JÁ DISPONÍVEIS
          // ==================================================
          messages = await withTimeout(
            client.getAllMessagesInChat(
              chatIdClean,
              true,   // includeMe
              false   // includeNotifications (OBRIGATÓRIO)
            ),
            WPP_TIMEOUT_MS,
            "getAllMessagesInChat"
          );
          break; // sucesso
        } catch (e: any) {
          const msg = String(e?.message || e || "");
          if (msg.includes("No LID for user")) {
            try {
              const numberOnly = chatIdClean.replace(/@.*/, "");
              const status = await withTimeout(client.checkNumberStatus(numberOnly), WPP_TIMEOUT_MS, "checkNumberStatus");
              if (!status || status.canReceiveMessage === false) {
                socket.emit("abrir_chat_error", { chatId: chatIdClean, error: "Número não encontrado no WhatsApp." });
                socket.emit("mensagens_chat", { chatId: chatIdClean, messages: [] });
                return;
              }
            } catch { }
            socket.emit("abrir_chat_error", { chatId: chatIdClean, error: "Não foi possível abrir o chat (LID ausente). Envie uma mensagem para iniciar a conversa." });
            socket.emit("mensagens_chat", { chatId: chatIdClean, messages: [] });
            return;
          }
          const recoverable =
            msg.includes("Promise was collected") ||
            msg.includes("Execution context was destroyed") ||
            msg.includes("Target closed") ||
            msg.includes("Session closed");

          if (attempt < 2 && recoverable) {
            console.warn(`⚠️ abrir_chat retry (${attempt}) para ${chatId}:`, msg);
            await sleep(700);
            continue;
          }
          throw e;
        }
      }

      const formatted = messages.map((m: any) => ({
        chatId: chatIdClean,
        body: m.body || "",
        mimetype: m.mimetype || null,
        isMedia: !!m.mimetype,
        timestamp: (m.timestamp || Date.now()) * 1000,
        fromMe: m.fromMe === true,
        _isFromMe: m.fromMe === true
      }));

      const limited = formatted.slice(-MAX_CHAT_MESSAGES);
      socket.emit("mensagens_chat", { chatId, messages: limited });

    } catch (err) {
      console.error("❌ Erro ao abrir chat:", err);
      socket.emit("mensagens_chat", { chatId, messages: [] });
    }
  });

  /**
   * =========================================================
   * ❌ DISCONNECT
   * =========================================================
   */
  // 🧹 LIMPAR HISTÓRICO DA IA (GEMINI) POR CHAT
  socket.on("ai:clear_history", async ({ chatId }) => {
    try {
      const userId = socket.data.userId as number | undefined;
      if (!userId || !chatId) return;

      const db = getDB();
      const session = await db.get(
        `SELECT session_name FROM sessions WHERE user_id = ? AND status = 'connected' LIMIT 1`,
        [userId]
      );

      if (!session) return;

      await stopChatSession(Number(userId), session.session_name, chatId);

      socket.emit("ai:history_cleared", { chatId });
      console.log(`🧹 Histórico Gemini limpo — user:${userId} chat:${chatId}`);
    } catch (err) {
      console.error("❌ Erro ao limpar histórico IA:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket desconectado:", socket.id);
  });
});

// =======================================
// 🔐 Middleware de Autenticação do Painel
// =======================================
async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.token;

    const isHtml = req.headers.accept?.includes("text/html");

    if (!token) {
      if (isHtml) return res.redirect("/login");
      return res.status(401).json({ error: "Não autenticado", redirect: "/login" });
    }

    const user = await findUserByToken(token);

    if (!user) {
      clearAuthCookie(res);
      if (isHtml) return res.redirect("/login");
      return res.status(401).json({ error: "Token inválido", redirect: "/login" });
    }

    if (isSessionExpired(user)) {
      clearAuthCookie(res);
      if (isHtml) return res.redirect("/login");
      return res.status(401).json({ error: "Sessão expirada", redirect: "/login" });
    }

    let reqUser = user;

    try {
      const refreshed = await ensureFreshUserSession(user);
      const currentExpiry = getTokenExpiresAt(user);

      if (refreshed.token !== user.token || refreshed.expiresAt !== currentExpiry) {
        setAuthCookie(res, refreshed.token);
        reqUser = {
          ...user,
          token: refreshed.token,
          token_expires_at: refreshed.expiresAt,
        };
      }
    } catch (refreshErr) {
      console.error("Erro ao renovar sessão:", refreshErr);
    }

    // ✅ SALVA O USER SEMPRE
    (req as any).user = reqUser;

    // ✅ libera rotas mesmo sem verificação
    const ALLOW_NOT_VERIFIED = [
      "/verify-email-required",
      "/auth/resend-verify-email",
      "/auth/logout",
      "/auth/me",
    ];

    if (ALLOW_NOT_VERIFIED.includes(req.path)) {
      return next();
    }

    const emailVerified = Number(reqUser.email_verified) === 1;

    if (!emailVerified) {
      if (isHtml) return res.redirect("/verify-email-required");

      return res.status(403).json({
        error: "Confirme seu e-mail antes de acessar.",
        redirect: "/verify-email-required",
      });
    }

    return next();
  } catch (err) {
    console.error("❌ authMiddleware error:", err);
    const isHtml = req.headers.accept?.includes("text/html");
    if (isHtml) return res.redirect("/login");
    return res.status(500).json({ error: "Erro de autenticação" });
  }
}

app.get("/verify-email-required", authMiddleware, (req, res) => {
  const user = (req as any).user;

  return res.render("verify-email-required", {
    email: user.email,
  });
});

// =======================================
// 📌 Rotas de Páginas (EJS)
// =======================================
// 👤 Página do usuário / assinatura
app.get("/user", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const db = getDB();

  // 🔹 Últimos pagamentos do usuário
  const paymentsRaw = await db.all(`
  SELECT amount, status, payment_method, created_at
  FROM payments
  WHERE user_id = ?
  ORDER BY created_at DESC
  LIMIT 5
`, [user.id]);

  const payments = paymentsRaw.map((p: any) => ({
    ...p,
    amount: Number(p.amount || 0) // 🔥 GARANTE NUMBER
  }));


  // 🔹 Último pagamento aprovado
  const lastPayment = await db.get(
    `
    SELECT created_at
    FROM payments
    WHERE user_id = ? AND status = 'approved'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [user.id]
  );

  res.render("user", {
    user,
    payments: payments || [],          // 🔥 SEMPRE define
    lastPaymentAt: lastPayment?.created_at || null,
    now: Date.now()
  });
});


// 💳 Página de Checkout
app.get("/checkout", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const plans = await listPlanConfigs();

  res.render("checkout", {
    user,
    plans,
  });
});

app.get("/checkout/success", authMiddleware, async (req, res) => {
  res.render("checkout-success");
});

app.get("/checkout/failure", authMiddleware, async (req, res) => {
  res.render("checkout-failure");
});

app.get("/checkout/pending", authMiddleware, async (req, res) => {
  res.render("checkout-pending");
});

app.get("/login", (_req, res) => {
  res.render("login"); // ⬅️ render EJS
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  let planConfig = null;

  try {
    planConfig = await getPlanConfig(user?.plan);
  } catch (err) {
    console.error("Erro ao carregar planConfig no /auth/me:", err);
  }

  res.json({ user, planConfig });
});

app.get("/", (_req, res) => res.redirect("/painel"));
app.get("/register", (_req, res) => {
  res.render("register");
});
app.get("/onboarding", (_req, res) => {
  res.render("onboarding");
});

app.get("/index.html", (_req, res) => res.redirect("/login"));

app.get("/chat", authMiddleware, subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const db = getDB();

  let sessionName = String(req.query.session || "").trim();

  // ✅ Se não vier na URL, pega a sessão conectada
  if (!sessionName) {
    const session = await db.get(
      `SELECT session_name
       FROM sessions
       WHERE user_id = ? AND status = 'connected'
       ORDER BY id DESC
       LIMIT 1`,
      [user.id]
    );

    sessionName = session?.session_name || "";
  }

  // 🔥 Se mesmo assim não existir sessão conectada
  if (!sessionName) {
    return res.redirect("/painel");
  }

  return res.render("chat", {
    user,
    sessionName,
  });
});

// 📌 Página CRM Kanban
app.get("/crm", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("crm", { user });
});

app.get("/api/crm/list", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSizeRaw = Number(req.query.pageSize) || 100;
    const pageSize = Math.min(200, Math.max(10, pageSizeRaw));
    const term = String(req.query.term || "").trim();

    const where: string[] = ["user_id = ?"];
    const params: any[] = [user.id];

    if (term) {
      where.push(`(name LIKE ? OR phone LIKE ? OR citystate LIKE ? OR tags LIKE ? OR notes LIKE ?)`);
      const like = `%${term}%`;
      params.push(like, like, like, like, like);
    }

    const whereSql = where.join(" AND ");

    const totalRow = await db.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM crm WHERE ${whereSql}`,
      params
    );
    const total = totalRow?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;

    const rows = await db.all(
      `SELECT id, user_id, name, phone, citystate, stage, tags, notes, deal_value, follow_up_date, avatar, last_seen
       FROM crm
       WHERE ${whereSql}
       ORDER BY last_seen DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const clients = rows.map((r: any) => ({
      ...r,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : [],
      notes: typeof r.notes === "string" ? JSON.parse(r.notes) : [],
    }));

    res.json({
      ok: true,
      clients,
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasMore: safePage < totalPages,
    });
  } catch (err) {
    console.error("❌ Erro ao listar CRM:", err);
    res.json({ ok: false, clients: [], page: 1, pageSize: 0, total: 0, totalPages: 1 });
  }
});

// 📌 Lista de chats
app.get("/api/chats", authMiddleware, async (_req, res) => {
  res.json({ ok: true });
});

// 📚 Base de conhecimento (RAG)
app.post("/api/kb/upload", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { name, content, sessionScope, fileBase64, fileName } = req.body || {};
    const safeName = String(name || "").trim() || "Documento";
    const session = sessionScope ? String(sessionScope) : null;

    if (fileBase64 && fileName) {
      let buffer: Buffer;
      try {
        buffer = decodeKbUploadBase64(String(fileBase64), String(fileName));
      } catch (err: any) {
        return res.status(400).json({ ok: false, error: err?.message || "Arquivo inválido" });
      }

      const result = await ingestFileSource({
        userId: user.id,
        filename: String(fileName),
        data: buffer,
        sessionScope: session,
      });
      if ((result as any).error) {
        return res.status(400).json({ ok: false, error: (result as any).error });
      }
      return res.json({ ok: true, sourceId: (result as any).sourceId, chunks: (result as any).chunks, tokens: (result as any).tokens });
    }

    const text = String(content || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "content ou fileBase64 são obrigatórios" });
    if (text.length > 200_000) {
      return res.status(400).json({ ok: false, error: "Limite de 200k caracteres por upload" });
    }

    const result = await ingestTextSource({
      userId: user.id,
      name: safeName,
      content: text,
      sessionScope: session,
    });

    return res.json({ ok: true, sourceId: result.sourceId, chunks: result.chunks, tokens: result.tokens });
  } catch (err) {
    console.error("Erro upload KB:", err);
    return res.status(500).json({ ok: false, error: "Erro ao processar upload" });
  }
});

app.post("/api/kb/url", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { url, name, sessionScope } = req.body || {};
    const safeUrl = String(url || "").trim();
    if (!safeUrl) return res.status(400).json({ ok: false, error: "url é obrigatório" });

    const result = await ingestUrlSource({
      userId: user.id,
      url: safeUrl,
      name: name ? String(name) : undefined,
      sessionScope: sessionScope ? String(sessionScope) : null,
    });

    const errorFlag = (result as any)?.error ?? null;
    return res.json({ ok: true, sourceId: result.sourceId, error: errorFlag });
  } catch (err) {
    console.error("Erro URL KB:", err);
    return res.status(500).json({ ok: false, error: "Erro ao cadastrar URL" });
  }
});

app.get("/api/kb/list", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const sources = await listSources(user.id);
    return res.json({ ok: true, sources });
  } catch (err) {
    console.error("Erro list KB:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar base" });
  }
});

app.post("/api/kb/query", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { query, sessionName, chatId, topK } = req.body || {};
    const q = String(query || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "query é obrigatória" });

    const results = await queryKb({
      userId: user.id,
      query: q,
      sessionName: sessionName ? String(sessionName) : undefined,
      chatId: chatId ? String(chatId) : undefined,
      topK: Number(topK) || 5,
    });

    return res.json({ ok: true, results });
  } catch (err) {
    console.error("Erro query KB:", err);
    return res.status(500).json({ ok: false, error: "Erro ao consultar base" });
  }
});

// 🗒️ Notas internas por chat (painel apenas)
app.get("/api/chat/notes", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const chatId = String(req.query.chatId || "").trim();
    const sessionName = String(req.query.sessionName || "").trim();

    if (!chatId || !sessionName) {
      return res.status(400).json({ ok: false, error: "chatId e sessionName são obrigatórios" });
    }

    const db = getDB();
    const notes = await db.all(
      `SELECT id, content, author_name, created_at
       FROM chat_notes
       WHERE user_id = ? AND session_name = ? AND chat_id = ?
       ORDER BY id DESC`,
      [user.id, sessionName, chatId]
    );

    return res.json({ ok: true, notes });
  } catch (err) {
    console.error("Erro ao listar notas:", err);
    return res.status(500).json({ ok: false, error: "Erro ao listar notas" });
  }
});

app.post("/api/chat/notes", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const chatId = String(req.body?.chatId || "").trim();
    const sessionName = String(req.body?.sessionName || "").trim();
    const content = String(req.body?.content || "").trim();

    if (!chatId || !sessionName || !content) {
      return res.status(400).json({ ok: false, error: "chatId, sessionName e content são obrigatórios" });
    }

    const safeContent = content.slice(0, 2000);
    const createdAt = Date.now();
    const authorName = user?.name || "Atendente";

    const db = getDB();
    await db.run(
      `INSERT INTO chat_notes (user_id, session_name, chat_id, attendant_id, author_name, content, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      [user.id, sessionName, chatId, authorName, safeContent, createdAt]
    );

    const notes = await db.all(
      `SELECT id, content, author_name, created_at
       FROM chat_notes
       WHERE user_id = ? AND session_name = ? AND chat_id = ?
       ORDER BY id DESC`,
      [user.id, sessionName, chatId]
    );

    return res.json({ ok: true, notes });
  } catch (err) {
    console.error("Erro ao salvar nota:", err);
    return res.status(500).json({ ok: false, error: "Erro ao salvar nota" });
  }
});

app.delete("/api/chat/notes/:id", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const id = Number(req.params.id);
    const sessionName = String(req.query.sessionName || "").trim();
    const chatId = String(req.query.chatId || "").trim();

    if (!id || !sessionName || !chatId) {
      return res.status(400).json({ ok: false, error: "id, chatId e sessionName são obrigatórios" });
    }

    const db = getDB();
    const existing = await db.get(
      `SELECT id FROM chat_notes WHERE id = ? AND user_id = ? AND session_name = ? AND chat_id = ?`,
      [id, user.id, sessionName, chatId]
    );
    if (!existing) return res.status(404).json({ ok: false, error: "Nota não encontrada" });

    await db.run(`DELETE FROM chat_notes WHERE id = ? AND user_id = ?`, [id, user.id]);

    const notes = await db.all(
      `SELECT id, content, author_name, created_at
       FROM chat_notes
       WHERE user_id = ? AND session_name = ? AND chat_id = ?
       ORDER BY id DESC`,
      [user.id, sessionName, chatId]
    );

    return res.json({ ok: true, notes });
  } catch (err) {
    console.error("Erro ao deletar nota:", err);
    return res.status(500).json({ ok: false, error: "Erro ao deletar nota" });
  }
});

// 📌 Detalhes de um cliente CRM (pipeline)
app.get("/api/crm/client/:chatId", authMiddleware, async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const user = (req as any).user;
    const db = getDB();

    const phone = chatId.replace("@c.us", "");

    const row = await db.get(
      `SELECT stage FROM crm WHERE user_id = ? AND phone = ?`,
      [user.id, phone]
    );

    res.json({
      pipeline: row?.stage || "Novo"
    });

  } catch (err) {
    console.error("Erro buscar pipeline:", err);
    res.json({ pipeline: "Novo" });
  }
});

// =======================================
// 🧠 Auxiliares
// =======================================
function requireFields(res: Response, fields: Record<string, any>) {
  for (const key in fields) {
    if (!fields[key]) {
      res.status(400).json({ error: `${key} é obrigatório` });
      return true;
    }
  }
  return false;
}
app.all("/auth/auto-login", (_req, res, next) => {
  if (_req.method !== "POST") {
    return res.status(405).json({ error: "Use POST com token no corpo ou Authorization" });
  }
  return next();
});

app.post("/auth/auto-login", async (req, res) => {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\\s+/i, "").trim();
  const token = String(req.body?.token || bearer || "").trim();
  if (!token) return res.status(400).json({ error: "token ausente" });

  const user = await findUserByToken(token);
  if (!user) return res.status(404).json({ error: "token inválido" });
  if (isSessionExpired(user)) {
    clearAuthCookie(res);
    return res.status(401).json({ error: "Sessão expirada", redirect: "/login" });
  }

  const session = await ensureFreshUserSession(user);
  setAuthCookie(res, session.token);

  res.json({
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
  });
});

app.get("/disparo", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("disparo", { user });
});
app.get("/agendamentos", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const planConfig = await getPlanConfig(user.plan);
  res.render("agendamentos", { user, planConfig });
});
app.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "");

    if (!token) {
      return res.send("Token inválido.");
    }

    const db = getDB();

    // 🔥 BUSCAR TAMBÉM O TOKEN DO USUÁRIO
    const user = await db.get<any>(
      `
      SELECT id, token, token_expires_at, email_verify_expires
      FROM users
      WHERE email_verify_token = ?
      `,
      [token]
    );

    if (!user) {
      return res.send("Token inválido ou expirado.");
    }

    if (
      !user.email_verify_expires ||
      Date.now() > Number(user.email_verify_expires)
    ) {
      return res.send("Token expirado. Solicite outro link.");
    }

    // ✅ CONFIRMA EMAIL
    await db.run(
      `
      UPDATE users
      SET email_verified = 1,
          email_verify_token = NULL,
          email_verify_expires = NULL
      WHERE id = ?
      `,
      [user.id]
    );

    const session = await ensureFreshUserSession(user);
    setAuthCookie(res, session.token);

    return res.redirect("/painel");

  } catch (err) {
    console.error("❌ Erro verify-email:", err);
    return res.status(500).send("Erro interno.");
  }
});

app.get("/reset-password", async (req, res) => {
  try {
    const token = String(req.query.token || "");

    if (!token) {
      return res.render("reset-password-invalid");
    }

    const db = getDB();

    const user = await db.get<any>(
      `
      SELECT id, reset_password_expires
      FROM users
      WHERE reset_password_token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!user) {
      return res.render("reset-password-invalid");
    }

    const expires = Number(user.reset_password_expires || 0);

    if (!expires || Date.now() > expires) {
      return res.render("reset-password-expired");
    }

    return res.render("reset-password", { token });

  } catch (err) {
    console.error("❌ GET /reset-password:", err);
    return res.render("reset-password-invalid");
  }
});
app.get("/forgot-password", (req, res) => {
  return res.render("forgot-password");
});

app.post("/auth/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.json({ error: "Token e senha são obrigatórios" });
    }

    if (password.length < 6) {
      return res.json({ error: "A senha deve ter pelo menos 6 caracteres" });
    }

    const db = getDB();

    const user = await db.get<any>(
      `
      SELECT id, reset_password_expires
      FROM users
      WHERE reset_password_token = ?
      LIMIT 1
      `,
      [token]
    );

    if (!user) {
      return res.json({ error: "Token inválido" });
    }

    const expires = Number(user.reset_password_expires || 0);

    if (!expires || Date.now() > expires) {
      return res.json({ error: "Token expirado" });
    }

    const hashed = await bcrypt.hash(password, 10);

    await db.run(
      `
      UPDATE users
      SET password = ?,
          reset_password_token = NULL,
          reset_password_expires = NULL
      WHERE id = ?
      `,
      [hashed, user.id]
    );

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ POST /auth/reset-password:", err);
    return res.json({ error: "Erro ao redefinir senha" });
  }
});

app.post("/auth/forgot-password", forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.json({ error: "Digite seu e-mail" });
    }

    await sendResetPasswordEmail(email);

    // sempre responde ok por segurança
    return res.json({
      ok: true,
      message: "Se esse e-mail existir, enviamos o link de recuperação."
    });

  } catch (err) {
    console.error("❌ forgot-password:", err);
    return res.json({
      ok: true,
      message: "Se esse e-mail existir, enviamos o link de recuperação."
    });
  }
});

app.post("/auth/resend-verify-email", authMiddleware, resendEmailLimiter, async (req, res) => {
  try {
    const user = (req as any).user;

    if (Number(user.email_verified) === 1) {
      return res.json({
        ok: true,
        message: "Seu e-mail já está verificado."
      });
    }

    await sendVerifyEmail(user.id);

    return res.json({
      ok: true,
      message: "E-mail reenviado com sucesso!"
    });

  } catch (err) {
    console.error("❌ Erro ao reenviar confirmação:", err);
    return res.status(500).json({
      error: "Erro ao reenviar e-mail."
    });
  }
});

// ===================================================
// 📣 API de DISPARO EM MASSA
// ===================================================
// ===================================================
// 📣 API de DISPARO EM MASSA (CORRIGIDO)
// ===================================================
app.post(
  "/api/disparo/validate-list",
  authMiddleware,
  disparoUserLimiter,
  subscriptionGuard,
  async (req: Request, res: Response) => {
    const user = (req as any).user as User & { plan?: string };
    const contactList = buildBroadcastContactsFromBody(req.body);

    if (!contactList.length) {
      return res.status(400).json({ error: "Nenhum numero valido informado." });
    }

    const planConfig = await getPlanConfig(user.plan);
    const maxBroadcastNumbers = planConfig?.maxBroadcastNumbers ?? 50;
    if (contactList.length > maxBroadcastNumbers) {
      return res.status(400).json({
        error: `Seu plano permite ate ${maxBroadcastNumbers} numero(s) por disparo.`,
      });
    }

    const connected = await listConnectedSessions(user.id);
    if (!connected.length) {
      return res.status(400).json({ error: "Nenhuma sessao ativa para este usuario." });
    }

    const preferred = String(req.body?.session_name || req.body?.sessionName || "").trim();
    const listValidation = await runListQualityValidation({
      userId: user.id,
      rawNumbers: buildRawNumbersFromBody(req.body),
      preferredSession: preferred || null,
      connectedSessions: connected,
      unavailableWarning:
        "Nao foi possivel validar a qualidade da lista com as sessoes conectadas no momento.",
    });

    if (!listValidation.validation) {
      return res.status(409).json({
        ok: false,
        blocked: false,
        error: "Nao foi possivel validar a lista com as sessoes conectadas no momento.",
        warnings: uniqueWarnings(listValidation.warnings),
      });
    }

    const warnings = [...listValidation.warnings];
    if (
      preferred &&
      listValidation.sessionName &&
      preferred !== listValidation.sessionName
    ) {
      warnings.push(
        `A sessao ${preferred} nao estava disponivel para validar a lista. A checagem usou ${listValidation.sessionName}.`
      );
    }

    const status = listValidation.validation.blocked ? 409 : 200;
    return res.status(status).json({
      ok: status === 200,
      blocked: listValidation.validation.blocked,
      error:
        listValidation.validation.blockReason ||
        (listValidation.validation.blocked
          ? listValidation.validation.recommendation
          : null),
      warnings: uniqueWarnings(warnings),
      session: listValidation.sessionName,
      listQuality: listValidation.validation,
    });
  }
);

app.post(
  "/api/disparo/check",
  authMiddleware,
  disparoUserLimiter,
  subscriptionGuard,
  async (req: Request, res: Response) => {
    const user = (req as any).user as User & { plan?: string };
    const contactList = buildBroadcastContactsFromBody(req.body);

    if (!contactList.length) {
      return res.status(400).json({ error: "Nenhum numero valido informado." });
    }

    const planConfig = await getPlanConfig(user.plan);
    const maxBroadcastNumbers = planConfig?.maxBroadcastNumbers ?? 50;
    if (contactList.length > maxBroadcastNumbers) {
      return res.status(400).json({
        error: `Seu plano permite ate ${maxBroadcastNumbers} numero(s) por disparo.`,
      });
    }

    const db = getDB();
    const connected = await listConnectedSessions(user.id);
    if (!connected.length) {
      return res.status(400).json({ error: "Nenhuma sessao ativa para este usuario." });
    }

    const preferred = String(req.body?.session_name || req.body?.sessionName || "").trim();
    const candidates = buildSessionCandidates(preferred, connected);
    const riskSession = candidates[0] || null;
    const policyResult = await evaluateDispatchPolicy({
      db,
      userId: user.id,
      contacts: contactList,
      campaignKind: "broadcast",
      preferredSession: riskSession,
      confirmLargeBatch: req.body?.confirmLargeBatch === true,
      plannedCount: contactList.length,
    });

    const listValidation = await runListQualityValidation({
      userId: user.id,
      rawNumbers: policyResult.allowedContacts.map((contact) => contact.number),
      preferredSession: preferred || null,
      connectedSessions: connected,
      unavailableWarning:
        "Nao foi possivel validar a qualidade da lista agora porque nenhuma sessao respondeu a checagem preventiva.",
    });

    const warnings = uniqueWarnings([
      ...policyResult.warnings,
      ...listValidation.warnings,
    ]);
    if (preferred && riskSession && preferred !== riskSession) {
      warnings.push(
        `A sessao ${preferred} nao estava conectada. A validacao foi estimada usando ${riskSession}.`
      );
    } else if (!preferred && riskSession) {
      warnings.push(
        `A validacao de aquecimento foi estimada usando a sessao ${riskSession}.`
      );
    }
    if (
      preferred &&
      listValidation.sessionName &&
      preferred !== listValidation.sessionName
    ) {
      warnings.push(
        `A sessao ${preferred} nao estava disponivel para validar a lista. A checagem usou ${listValidation.sessionName}.`
      );
    }

    const error =
      listValidation.validation?.blockReason ||
      (listValidation.validation?.blocked
        ? listValidation.validation.recommendation
        : null) ||
      policyResult.blockReason ||
      policyResult.confirmationMessage ||
      null;
    const status =
      policyResult.blocked ||
      policyResult.requiresConfirmation ||
      listValidation.validation?.blocked
        ? 409
        : 200;

    return res.status(status).json({
      ok: status === 200,
      blocked: Boolean(policyResult.blocked || listValidation.validation?.blocked),
      requiresConfirmation: Boolean(policyResult.requiresConfirmation),
      error,
      warnings: uniqueWarnings(warnings),
      skipped: policyResult.skippedContacts.length,
      session: riskSession,
      validationSession: listValidation.sessionName,
      listQuality: listValidation.validation,
    });
  }
);

app.post(
  "/api/disparo",
  authMiddleware,
  disparoUserLimiter,
  subscriptionGuard,
  async (req: Request, res: Response) => {

    const {
      number,
      message,
      file,
      filename,
      session_name,
      sessionName,
      confirmLargeBatch,
    } = req.body;
    const user = (req as any).user as User & { plan?: string };

    if (!number && !Array.isArray(req.body?.contacts) && !Array.isArray(req.body?.numbers)) {
      return res.status(400).json({ error: "Numero e obrigatorio" });
    }

    const contactList: PersonalizedContact[] = buildBroadcastContactsFromBody(req.body);

    if (!contactList.length) {
      return res.status(400).json({ error: "Nenhum número válido" });
    }

    const planConfig = await getPlanConfig(user.plan);
    const maxBroadcastNumbers = planConfig?.maxBroadcastNumbers ?? 50;
    if (contactList.length > maxBroadcastNumbers) {
      return res.status(400).json({
        error: `Seu plano permite até ${maxBroadcastNumbers} número(s) por disparo.`,
      });
    }

    const hasTextMessage = contactList.some((c) => (c.message ?? message ?? "").trim().length > 0);
    if (!file && !hasTextMessage) {
      return res.status(400).json({
        error: "Mensagem ou imagem é obrigatória"
      });
    }

    let dispatchMedia: PreparedMediaFile | null = null;
    try {
      if (file) {
        const safeFile = sanitizeIncomingFile({ dataUrl: file as string, filename });
        dispatchMedia = prepareDispatchFileForSend(user.id, safeFile);
      }

      const db = getDB();
      const connected = await listConnectedSessions(user.id);
      if (!connected.length) {
        return res.status(400).json({ error: "Nenhuma sessão ativa para este usuário" });
      }

      const preferred = (session_name || sessionName || "").trim();
      const candidates = buildSessionCandidates(preferred, connected);
      const effectivePreferred = candidates[0] || null;
      const campaignRef = `broadcast:${Date.now()}:${crypto.randomUUID()}`;
      const policyResult = await evaluateDispatchPolicy({
        db,
        userId: user.id,
        contacts: contactList,
        campaignKind: "broadcast",
        preferredSession: effectivePreferred,
        confirmLargeBatch: confirmLargeBatch === true,
        plannedCount: contactList.length,
      });

      await recordSkippedDispatchContacts(db, {
        userId: user.id,
        campaignKind: "broadcast",
        campaignRef,
        skips: policyResult.skippedContacts,
      });

      const policyWarnings = uniqueWarnings(policyResult.warnings);
      if (policyResult.requiresConfirmation) {
        return res.status(409).json({
          error: policyResult.confirmationMessage || "Confirmação adicional necessária.",
          warnings: policyWarnings,
          skipped: policyResult.skippedContacts.length,
          requiresConfirmation: true,
          retryable: false,
        });
      }

      if (policyResult.blocked) {
        return res.status(409).json({
          error: policyResult.blockReason || "Campanha bloqueada pela política de envio.",
          warnings: policyWarnings,
          skipped: policyResult.skippedContacts.length,
          retryable: false,
        });
      }

      const listValidation = await runListQualityValidation({
        userId: user.id,
        rawNumbers: policyResult.allowedContacts.map((contact) => contact.number),
        preferredSession: preferred || null,
        connectedSessions: connected,
        unavailableWarning:
          "Nao foi possivel validar a qualidade da lista agora porque nenhuma sessao respondeu a checagem preventiva.",
      });
      const validationWarnings = uniqueWarnings([
        ...policyWarnings,
        ...listValidation.warnings,
      ]);
      if (
        preferred &&
        listValidation.sessionName &&
        preferred !== listValidation.sessionName
      ) {
        validationWarnings.push(
          `A sessao ${preferred} nao estava disponivel para validar a lista. A checagem usou ${listValidation.sessionName}.`
        );
      }

      if (listValidation.validation?.blocked) {
        return res.status(409).json({
          error:
            listValidation.validation.blockReason ||
            listValidation.validation.recommendation ||
            "Campanha bloqueada por baixa qualidade da lista.",
          warnings: uniqueWarnings(validationWarnings),
          skipped: policyResult.skippedContacts.length,
          retryable: false,
          blocked: true,
          listQuality: listValidation.validation,
        });
      }

      let lastError: any = null;
      let lastWarnings = uniqueWarnings(validationWarnings);
      for (const shortName of candidates) {
        const full = `USER${user.id}_${shortName}`;
        const client = getClient(full);
        if (!client) {
          lastError = `Sessão ${shortName} indisponível`;
          continue;
        }

        const sessionHealth = await evaluateDispatchSessionHealth({
          db,
          userId: user.id,
          sessionName: shortName,
        });
        lastWarnings = uniqueWarnings([...lastWarnings, ...sessionHealth.warnings]);
        if (sessionHealth.blocked) {
          lastError = sessionHealth.reason;
          continue;
        }

        const sessionRisk = await evaluateDispatchCampaignRisk({
          db,
          userId: user.id,
          sessionName: shortName,
          plannedCount: policyResult.allowedContacts.length,
        });
        lastWarnings = uniqueWarnings([...lastWarnings, ...sessionRisk.warnings]);
        if (sessionRisk.blocked) {
          lastError = sessionRisk.reason;
          continue;
        }

        let sent = 0;
        let errors = 0;
        let processed = 0;
        let consecutiveFailures = 0;
        let campaignPauseReason: string | null = null;

        for (const contact of policyResult.allowedContacts) {
          try {
            const chatId = await ensureChat(client, contact.number);
            const finalMessage = renderTemplate(contact.message ?? message ?? "", contact);

            if (!dispatchMedia) {
              await withTimeout(client.sendText(chatId, finalMessage), WPP_TIMEOUT_MS, "sendText");
            } else {
              await withTimeout(
                client.sendFile(
                  chatId,
                  dispatchMedia.content,
                  dispatchMedia.filename || filename || "arquivo",
                  finalMessage
                ),
                WPP_TIMEOUT_MS,
                "sendFile"
              );
            }

            sent += 1;
            processed += 1;
            consecutiveFailures = 0;
            await recordDispatchContactEvent(
              {
                userId: user.id,
                sessionName: shortName,
                campaignKind: "broadcast",
                campaignRef,
                phone: contact.number,
                status: "sent",
              },
              db
            );
          } catch (err: any) {
            const classified = classifyDispatchError(err);
            console.error(`⚠️ Erro no disparo pela sessão ${shortName}:`, err);
            errors += 1;
            processed += 1;
            consecutiveFailures += 1;
            lastError = classified.message;
            await recordDispatchContactEvent(
              {
                userId: user.id,
                sessionName: shortName,
                campaignKind: "broadcast",
                campaignRef,
                phone: contact.number,
                status: "error",
                errorCode: classified.code,
                errorMessage: classified.message,
              },
              db
            );

            const runtimePauseReason = getCampaignPauseReason({
              sessionName: shortName,
              processed,
              failures: errors,
              consecutiveFailures,
            });
            if (runtimePauseReason) {
              campaignPauseReason = runtimePauseReason;
              lastWarnings = uniqueWarnings([...lastWarnings, runtimePauseReason]);
              break;
            }
          }
        }

        if (campaignPauseReason && !sent) {
          return res.status(409).json({
            error: campaignPauseReason,
            warnings: uniqueWarnings(lastWarnings),
            skipped: policyResult.skippedContacts.length,
            retryable: false,
            paused: true,
          });
        }

        if (sent > 0) {
          await logAudit("broadcast_send", user.id, "session", shortName, {
            sent,
            errors,
            contacts: policyResult.allowedContacts.length,
            file: Boolean(file),
            warnings: uniqueWarnings(lastWarnings),
            paused: Boolean(campaignPauseReason),
          });
          return res.json({
            ok: true,
            session: shortName,
            sent,
            errors,
            skipped: policyResult.skippedContacts.length,
            warnings: uniqueWarnings(lastWarnings),
            paused: Boolean(campaignPauseReason),
            stoppedReason: campaignPauseReason,
          });
        }
      }

      return res.status(500).json({
        error: "Não foi possível enviar por nenhuma sessão conectada",
        detail: lastError || null,
        warnings: uniqueWarnings(lastWarnings),
      });

    } catch (err) {
      console.error("⚠️ Erro no disparo:", err);
      return res.status(500).json({
        error: "Erro ao enviar mensagem"
      });
    } finally {
      cleanupLocalMediaFile(dispatchMedia?.cleanupPath);
    }
  }
);

app.post("/api/disparo/log", authMiddleware, async (req: Request, res: Response) => {
  const user = (req as any).user as User;
  const totalNumbers = Number(req.body?.total_numbers || 0);
  const successCount = Number(req.body?.success_count || 0);
  const failCount = Number(req.body?.fail_count || 0);
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  const status = typeof req.body?.status === "string" ? req.body.status : "completed";

  if (![totalNumbers, successCount, failCount].every((value) => Number.isFinite(value) && value >= 0)) {
    return res.status(400).json({ error: "Totais do histórico inválidos." });
  }

  const safeTotal = Math.max(totalNumbers, successCount + failCount);
  const successRate = safeTotal ? Number(((successCount / safeTotal) * 100).toFixed(2)) : 0;

  try {
    await getDB().run(
      `INSERT INTO disparo_history (
        user_id,
        total_numbers,
        success_count,
        fail_count,
        success_rate,
        message,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [user.id, safeTotal, successCount, failCount, successRate, message || null, status]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("⚠️ Erro ao registrar histórico de disparo:", err);
    return res.status(500).json({ error: "Falha ao registrar histórico do disparo." });
  }
});

// ===============================
// 📅 API — AGENDAMENTOS
// ===============================

// Criar agendamento
app.post("/api/agendamentos/create", authMiddleware, subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const { numbers, contacts, message, file, filename, sendAt, recurrenceEnd, session_name, sessionName } = req.body;
  const recurrenceRaw = (req.body?.recurrence || "none") as string;
  const recurrenceAllowed = ["none", "daily", "weekly", "monthly"];
  const recurrence = recurrenceAllowed.includes(recurrenceRaw) ? recurrenceRaw : "none";

  const sendAtMs = Number(sendAt);
  const recurrenceEndMs = recurrenceEnd ? Number(recurrenceEnd) : null;

  const contactsArr: any[] = Array.isArray(contacts) ? contacts : [];
  const hasPersonalized = contactsArr.length > 0;
  const numbersArr: any[] = Array.isArray(numbers) ? numbers : [];
  const contactList = hasPersonalized ? buildContactsFromPayload(contactsArr) : [];

  if ((!hasPersonalized && !numbersArr.length) || !sendAtMs)
    return res.status(400).json({ error: "Dados incompletos" });

  if (!Number.isFinite(sendAtMs))
    return res.status(400).json({ error: "Data inválida" });

  if (sendAtMs <= Date.now())
    return res.status(400).json({ error: "Data precisa ser futura" });

  if (recurrence !== "none" && recurrenceEndMs) {
    if (!Number.isFinite(recurrenceEndMs)) return res.status(400).json({ error: "Fim da recorrência inválido" });
    if (recurrenceEndMs <= sendAtMs) return res.status(400).json({ error: "Fim da recorrência deve ser após a 1ª data" });
    if (recurrenceEndMs <= Date.now()) return res.status(400).json({ error: "Fim da recorrência não pode ser no passado" });
  }

  const hasTextMessage = hasPersonalized
    ? contactList.some((c) => (c.message ?? message ?? "").trim().length > 0)
    : String(message || "").trim().length > 0;

  if (!file && !hasTextMessage) {
    return res.status(400).json({ error: "Mensagem ou arquivo é obrigatório" });
  }

  const planConfig = await getPlanConfig(user.plan);
  const planLabel = planConfig?.displayName || String(user.plan || "starter");
  const maxNumbers = planConfig?.maxBroadcastNumbers ?? 50;
  const totalCount = hasPersonalized ? contactsArr.length : numbersArr.length;
  if (totalCount > maxNumbers) {
    return res.status(400).json({
      error: `Limite de ${maxNumbers} números para seu plano (${planLabel}). Reduza a lista.`,
    });
  }

  const normalized = hasPersonalized
    ? contactList
    : numbersArr
        .map((n) => {
          const { ok, sanitized } = validatePhone(n);
          return ok ? sanitized : null;
        })
        .filter(Boolean);

  if (!normalized.length) return res.status(400).json({ error: "Nenhum número válido" });

  const db = getDB();
  const preferredSession = (session_name || sessionName || "").trim() || null;
  const policyContacts = hasPersonalized
    ? contactList
    : normalized.map((entry) => ({
        number: String(entry),
        message,
      }));
  const policyResult = await evaluateDispatchPolicy({
    db,
    userId: user.id,
    contacts: policyContacts,
    campaignKind: "schedule",
    preferredSession,
    scheduledAt: sendAtMs,
    plannedCount: totalCount,
  });

  if (policyResult.blocked) {
    return res.status(409).json({
      error: policyResult.blockReason || "Agendamento bloqueado pela política de envio.",
      warnings: uniqueWarnings(policyResult.warnings),
      skipped: policyResult.skippedContacts,
    });
  }

  const filteredSchedulePayload = hasPersonalized
    ? policyResult.allowedContacts
    : policyResult.allowedContacts.map((contact) => contact.number);

  if (!filteredSchedulePayload.length) {
    return res.status(409).json({
      error: "Nenhum contato elegível restou após aplicar as regras da campanha.",
      warnings: uniqueWarnings(policyResult.warnings),
      skipped: policyResult.skippedContacts,
    });
  }

  const connectedSessions = await listConnectedSessions(user.id);
  const scheduleNumbersForValidation = hasPersonalized
    ? (filteredSchedulePayload as PersonalizedContact[]).map((contact) => contact.number)
    : (filteredSchedulePayload as string[]);
  const listValidation = await runListQualityValidation({
    userId: user.id,
    rawNumbers: scheduleNumbersForValidation,
    preferredSession,
    connectedSessions,
    unavailableWarning:
      "Nao foi possivel validar a qualidade da lista agora porque nenhuma sessao conectada estava disponivel. O sistema tentara validar novamente quando o agendamento executar.",
  });
  const scheduleWarnings = uniqueWarnings([
    ...policyResult.warnings,
    ...listValidation.warnings,
  ]);
  if (
    preferredSession &&
    listValidation.sessionName &&
    preferredSession !== listValidation.sessionName
  ) {
    scheduleWarnings.push(
      `A sessao ${preferredSession} nao estava disponivel para validar a lista. A checagem usou ${listValidation.sessionName}.`
    );
  }

  if (listValidation.validation?.blocked) {
    return res.status(409).json({
      error:
        listValidation.validation.blockReason ||
        listValidation.validation.recommendation ||
        "Agendamento bloqueado por baixa qualidade da lista.",
      warnings: uniqueWarnings(scheduleWarnings),
      skipped: policyResult.skippedContacts,
      listQuality: listValidation.validation,
    });
  }

  let safeFile: SanitizedFile | null = null;
  let storedFilePath: string | null = null;
  let storedFilename: string | null = null;
  if (file) {
    try {
      safeFile = sanitizeIncomingFile({ dataUrl: file as string, filename });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || "Arquivo inválido" });
    }
    try {
      storedFilePath = persistScheduleFile(user.id, safeFile);
      storedFilename = safeFile.filename;
      releaseMediaPayload(safeFile);
    } catch (err: any) {
      console.error("⚠️ Erro ao salvar arquivo do agendamento:", err);
      return res.status(500).json({ error: "Falha ao salvar arquivo" });
    }
  }

  // Checar duplicado: mesmo user, mesma data, mesma lista
  const existingDup = await db.get<{ id: number }>(
    `SELECT id FROM schedules
     WHERE user_id = ? AND status = 'pending' AND send_at = ? AND numbers = ?
     LIMIT 1`,
    [user.id, sendAtMs, JSON.stringify(filteredSchedulePayload)]
  );
  if (existingDup && req.body?.forceDuplicate !== true) {
    return res.status(409).json({
      duplicate: true,
      existingId: existingDup.id,
      message: "Já existe um agendamento igual (mesmos números e data)."
    });
  }

  await db.run(
    `INSERT INTO schedules (user_id, numbers, message, file, filename, preferred_session, send_at, recurrence, recurrence_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      JSON.stringify(filteredSchedulePayload),
      message,
      storedFilePath,
      storedFilename,
      preferredSession,
      sendAtMs,
      recurrence,
      recurrenceEndMs,
    ]
  );

  res.json({
    ok: true,
    warnings: uniqueWarnings(scheduleWarnings),
    skipped: policyResult.skippedContacts,
    listQuality: listValidation.validation,
  });
});

// Editar agendamento pendente
app.put("/api/agendamentos/update/:id", authMiddleware, subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const {
    numbers,
    contacts,
    message,
    file,
    filename,
    sendAt,
    keepExistingFile,
    recurrence,
    recurrenceEnd,
    session_name,
    sessionName,
  } = req.body || {};

  const sendAtMs = Number(sendAt);
  const recurrenceEndMs = recurrenceEnd ? Number(recurrenceEnd) : null;
  const contactsArr: any[] = Array.isArray(contacts) ? contacts : [];
  const hasPersonalized = contactsArr.length > 0;
  const numbersArr: any[] = Array.isArray(numbers) ? numbers : [];
  const contactList = hasPersonalized ? buildContactsFromPayload(contactsArr) : [];

  if ((!hasPersonalized && !numbersArr.length) || !sendAtMs)
    return res.status(400).json({ error: "Dados incompletos" });

  if (!Number.isFinite(sendAtMs))
    return res.status(400).json({ error: "Data inválida" });

  if (sendAtMs <= Date.now())
    return res.status(400).json({ error: "Data precisa ser futura" });

  if (recurrence !== "none" && recurrenceEndMs) {
    if (!Number.isFinite(recurrenceEndMs)) return res.status(400).json({ error: "Fim da recorrência inválido" });
    if (recurrenceEndMs <= sendAtMs) return res.status(400).json({ error: "Fim da recorrência deve ser após a 1ª data" });
    if (recurrenceEndMs <= Date.now()) return res.status(400).json({ error: "Fim da recorrência não pode ser no passado" });
  }

  const db = getDB();
  const existing = await db.get<any>(
    `SELECT * FROM schedules WHERE id = ? AND user_id = ?`,
    [id, user.id]
  );
  if (!existing) return res.status(404).json({ error: "Agendamento não encontrado" });
  if (existing.status !== "pending") {
    return res.status(400).json({ error: "Somente agendamentos pendentes podem ser editados" });
  }

  const hasTextMessage = hasPersonalized
    ? contactList.some((c) => (c.message ?? message ?? existing.message ?? "").trim().length > 0)
    : String(message ?? existing.message ?? "").trim().length > 0;

  if (!file && !keepExistingFile && !hasTextMessage) {
    return res.status(400).json({ error: "Mensagem ou arquivo é obrigatório" });
  }

  const planConfig = await getPlanConfig(user.plan);
  const planLabel = planConfig?.displayName || String(user.plan || "starter");
  const maxNumbers = planConfig?.maxBroadcastNumbers ?? 50;
  const totalCount = hasPersonalized ? contactsArr.length : numbersArr.length;
  if (totalCount > maxNumbers) {
    return res.status(400).json({
      error: `Limite de ${maxNumbers} números para seu plano (${planLabel}). Reduza a lista.`,
    });
  }

  const normalized = hasPersonalized
    ? contactList
    : numbersArr
        .map((n) => {
          const { ok, sanitized } = validatePhone(n);
          return ok ? sanitized : null;
        })
        .filter(Boolean);

  if (!normalized.length) return res.status(400).json({ error: "Nenhum número válido" });

  const preferredSession = (session_name || sessionName || "").trim() || null;
  const policyContacts = hasPersonalized
    ? contactList
    : normalized.map((entry) => ({
        number: String(entry),
        message: message ?? existing.message ?? "",
      }));
  const policyResult = await evaluateDispatchPolicy({
    db,
    userId: user.id,
    contacts: policyContacts,
    campaignKind: "schedule",
    preferredSession,
    scheduledAt: sendAtMs,
    plannedCount: totalCount,
  });
  const filteredSchedulePayload = hasPersonalized
    ? policyResult.allowedContacts
    : policyResult.allowedContacts.map((contact) => contact.number);

  if (policyResult.blocked) {
    return res.status(409).json({
      error: policyResult.blockReason || "Agendamento bloqueado pela política de envio.",
      warnings: uniqueWarnings(policyResult.warnings),
      skipped: policyResult.skippedContacts,
    });
  }

  if (!filteredSchedulePayload.length) {
    return res.status(409).json({
      error: "Nenhum contato elegível para esse agendamento.",
      warnings: uniqueWarnings(policyResult.warnings),
      skipped: policyResult.skippedContacts,
    });
  }

  const recurrenceRaw = (recurrence || existing.recurrence || "none") as string;
  const allowed = ["none", "daily", "weekly", "monthly"];
  const finalRecurrence = allowed.includes(recurrenceRaw) ? recurrenceRaw : "none";
  const finalRecurrenceEnd = recurrenceEndMs ?? existing.recurrence_end ?? null;

  const connectedSessions = await listConnectedSessions(user.id);
  const scheduleNumbersForValidation = hasPersonalized
    ? (filteredSchedulePayload as PersonalizedContact[]).map((contact) => contact.number)
    : (filteredSchedulePayload as string[]);
  const listValidation = await runListQualityValidation({
    userId: user.id,
    rawNumbers: scheduleNumbersForValidation,
    preferredSession,
    connectedSessions,
    unavailableWarning:
      "Nao foi possivel validar a qualidade da lista agora porque nenhuma sessao conectada estava disponivel. O sistema tentara validar novamente quando o agendamento executar.",
  });
  const scheduleWarnings = uniqueWarnings([
    ...policyResult.warnings,
    ...listValidation.warnings,
  ]);
  if (
    preferredSession &&
    listValidation.sessionName &&
    preferredSession !== listValidation.sessionName
  ) {
    scheduleWarnings.push(
      `A sessao ${preferredSession} nao estava disponivel para validar a lista. A checagem usou ${listValidation.sessionName}.`
    );
  }

  if (listValidation.validation?.blocked) {
    return res.status(409).json({
      error:
        listValidation.validation.blockReason ||
        listValidation.validation.recommendation ||
        "Agendamento bloqueado por baixa qualidade da lista.",
      warnings: uniqueWarnings(scheduleWarnings),
      skipped: policyResult.skippedContacts,
      listQuality: listValidation.validation,
    });
  }

  let safeFile: SanitizedFile | null = null;
  if (file) {
    try {
      safeFile = sanitizeIncomingFile({ dataUrl: file as string, filename });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || "Arquivo inválido" });
    }
  }

  // Checar duplicado (exclui o próprio)
  const dup = await db.get<{ id: number }>(
    `SELECT id FROM schedules
     WHERE user_id = ? AND status = 'pending' AND send_at = ? AND numbers = ? AND id <> ?
     LIMIT 1`,
    [user.id, sendAtMs, JSON.stringify(filteredSchedulePayload), id]
  );
  if (dup && req.body?.forceDuplicate !== true) {
    return res.status(409).json({
      duplicate: true,
      existingId: dup.id,
      message: "Já existe um agendamento igual (mesmos números e data)."
    });
  }

  const existingRow = existing as ScheduleRow;
  let finalFilePath: string | null = null;
  let finalFilename: string | null = null;

  if (safeFile) {
    try {
      finalFilePath = persistScheduleFile(user.id, safeFile);
      finalFilename = safeFile.filename;
      releaseMediaPayload(safeFile);
      await deleteScheduleFileIfUnused(db, existingRow.file);
    } catch (err: any) {
      console.error("⚠️ Erro ao salvar arquivo do agendamento:", err);
      return res.status(500).json({ error: "Falha ao salvar arquivo" });
    }
  } else if (keepExistingFile) {
    const ensured = await ensureScheduleFileOnDisk(db, existingRow);
    if (existingRow.file && !ensured.file) {
      return res.status(409).json({
        error: "O arquivo atual deste agendamento não está mais disponível. Reenvie a mídia para salvar.",
      });
    }
    finalFilePath = ensured.storedPath;
    finalFilename = ensured.storedPath ? existingRow.filename : null;
  } else {
    await deleteScheduleFileIfUnused(db, existingRow.file);
    finalFilePath = null;
    finalFilename = null;
  }

  // permitir override de filename vindo do payload
  if (filename && safeFile) {
    finalFilename = safeFile.filename;
  } else if (filename && !safeFile && keepExistingFile) {
    finalFilename = filename;
  }

  const finalPreferredSession = preferredSession || existingRow.preferred_session || null;

  await db.run(
    `UPDATE schedules
     SET numbers = ?, message = ?, file = ?, filename = ?, preferred_session = ?, send_at = ?, recurrence = ?, recurrence_end = ?
     WHERE id = ? AND user_id = ?`,
    [
      JSON.stringify(filteredSchedulePayload),
      message,
      finalFilePath,
      finalFilename,
      finalPreferredSession,
      sendAtMs,
      finalRecurrence,
      finalRecurrenceEnd,
      id,
      user.id,
    ]
  );

  return res.json({
    ok: true,
    warnings: uniqueWarnings(scheduleWarnings),
    skipped: policyResult.skippedContacts,
    listQuality: listValidation.validation,
  });
});

// Listar agendamentos do usuário
app.get("/api/agendamentos/list", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const db = getDB();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 10));
  const status = String(req.query.status || "all");
  const term = String(req.query.term || "").trim();
  const from = Number(req.query.from || 0);
  const to = Number(req.query.to || 0);
  const orderByRaw = String(req.query.orderBy || "send_at");
  const orderDirRaw = String(req.query.orderDir || "desc");

  const orderable = ["send_at", "status"];
  const orderDirAllowed = ["asc", "desc"];
  const orderBy = orderable.includes(orderByRaw) ? orderByRaw : "send_at";
  const orderDir = orderDirAllowed.includes(orderDirRaw) ? orderDirRaw : "desc";

  const where: string[] = ["user_id = ?"];
  const params: any[] = [user.id];

  if (status !== "all") {
    where.push("status = ?");
    params.push(status);
  }

  if (from > 0) {
    where.push("send_at >= ?");
    params.push(from);
  }

  if (to > 0) {
    where.push("send_at <= ?");
    params.push(to);
  }

  if (term) {
    where.push("(message LIKE ? OR numbers LIKE ?)");
    params.push(`%${term}%`, `%${term}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await db.get<{ total: number }>(
    `SELECT COUNT(*) as total FROM schedules ${whereSql}`,
    params
  );
  const total = totalRow?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  const rows = await db.all(
    `SELECT * FROM schedules
     ${whereSql}
     ORDER BY ${orderBy} ${orderDir}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  res.json({ rows, total, page: safePage, pageSize, totalPages });
});

// Logs de execução (alerta no painel)
app.get("/api/agendamentos/logs", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const afterId = Number(req.query.after || 0);
  const db = getDB();

  let sql = `
    SELECT id, schedule_id, success_count, failure_count, sent_at
    FROM schedule_logs
    WHERE user_id = ?
  `;
  const params: any[] = [user.id];

  if (Number.isFinite(afterId) && afterId > 0) {
    sql += " AND id > ?";
    params.push(afterId);
  }

  sql += " ORDER BY id ASC LIMIT 20";

  const rows = await db.all(sql, params);
  res.json({ logs: rows });
});

// Detalhe de log de agendamento (último log + itens)
app.get("/api/agendamentos/log/:id", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const scheduleId = Number(req.params.id);
  if (!Number.isFinite(scheduleId)) return res.status(400).json({ error: "ID inválido" });

  const db = getDB();
  const log = await db.get<any>(
    `SELECT * FROM schedule_logs WHERE schedule_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
    [scheduleId, user.id]
  );
  if (!log) return res.status(404).json({ error: "Nenhum log encontrado" });

  const items = await db.all<any>(
    `SELECT number, status, error, sent_at FROM schedule_log_items WHERE log_id = ? ORDER BY id ASC`,
    [log.id]
  );

  res.json({ log, items });
});

// Excluir agendamento
app.delete("/api/agendamentos/delete/:id", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const id = req.params.id;
  const db = getDB();
  const existing = await db.get<ScheduleRow>(`SELECT * FROM schedules WHERE id = ? AND user_id = ?`, [id, user.id]);
  if (existing?.file) {
    await deleteScheduleFileIfUnused(db, existing.file);
  }
  await db.run(`DELETE FROM schedules WHERE id = ? AND user_id = ?`, [
    id,
    user.id,
  ]);
  res.json({ ok: true });
});

function calculateNextSendAt(current: number, recurrence: string, recurrenceEnd?: number | null): number | null {
  const base = new Date(current);
  const now = Date.now();

  const bump = () => {
    switch (recurrence) {
      case "daily":
        base.setDate(base.getDate() + 1);
        return true;
      case "weekly":
        base.setDate(base.getDate() + 7);
        return true;
      case "monthly":
        base.setMonth(base.getMonth() + 1);
        return true;
      default:
        return false;
    }
  };

  if (!bump()) return null;

  const nextTs = base.getTime();
  if (recurrenceEnd && nextTs > recurrenceEnd) return null;

  if (nextTs <= now) {
    return calculateNextSendAt(nextTs, recurrence, recurrenceEnd);
  }

  return nextTs;
}

async function insertScheduleExecutionLog(
  db: DBClient,
  row: Pick<ScheduleRow, "id" | "user_id">,
  successCount: number,
  failureCount: number,
  itemLogs: ScheduleItemLog[],
  sentAt: number
) {
  const logInsert = await db.run(
    `INSERT INTO schedule_logs (schedule_id, user_id, success_count, failure_count, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.user_id, successCount, failureCount, sentAt, sentAt]
  );

  const logId = (logInsert as any)?.insertId;
  if (!logId) return;

  if (!itemLogs.length) return;

  const valuesSql = itemLogs.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  const params = itemLogs.flatMap((item) => [
    logId,
    row.id,
    row.user_id,
    item.number,
    item.status,
    item.error || null,
    item.sentAt,
  ]);

  await db.run(
    `INSERT INTO schedule_log_items (log_id, schedule_id, user_id, number, status, error, sent_at)
     VALUES ${valuesSql}`,
    params
  );
}

async function sendScheduleMediaUnavailableEmail(
  db: DBClient,
  row: Pick<ScheduleRow, "id" | "user_id" | "message" | "send_at" | "filename">,
  failureReason: string,
  notificationUser?: ScheduleNotificationUser | null
) {
  try {
    const user =
      notificationUser ||
      await db.get<ScheduleNotificationUser>(
        `SELECT name, email FROM users WHERE id = ?`,
        [row.user_id]
      );

    if (!user?.email) return;

    const html = `
      <p>Olá ${user.name || ""},</p>
      <p>O agendamento <b>#${row.id}</b> não foi enviado porque a mídia anexada não está mais disponível no servidor.</p>
      <p><b>Motivo:</b> ${failureReason}</p>
      <p><b>Arquivo:</b> ${row.filename || "arquivo não identificado"}</p>
      <p><b>Data programada:</b> ${new Date(row.send_at).toLocaleString("pt-BR")}</p>
      <p><b>Mensagem:</b> ${row.message ? row.message.substring(0, 120) : "(sem texto)"}${row.message && row.message.length > 120 ? "..." : ""}</p>
      <p>Abra a tela de agendamentos, duplique ou recrie este envio e anexe o arquivo novamente.</p>
    `;

    await sendEmail(user.email, `Agendamento #${row.id} bloqueado por mídia indisponível`, html);
  } catch (err: any) {
    console.error("⚠️ Falha ao enviar notificação de mídia indisponível:", err?.message || err);
  }
}

async function failScheduleDueToMissingMedia(
  db: DBClient,
  row: ScheduleRow,
  contactsList: PersonalizedContact[],
  failureReason: string,
  notificationUser?: ScheduleNotificationUser | null
) {
  const processedAt = Date.now();
  const itemLogs: ScheduleItemLog[] = contactsList.map((contact) => ({
    number: contact.number,
    status: "error",
    error: failureReason,
    sentAt: processedAt,
  }));

  await db.run(
    `UPDATE schedules SET status = 'failed', processing_started_at = NULL WHERE id = ?`,
    [row.id]
  );
  await insertScheduleExecutionLog(db, row, 0, contactsList.length, itemLogs, processedAt);
  await sendScheduleMediaUnavailableEmail(db, row, failureReason, notificationUser);
}

async function requeueScheduleForLater(
  db: DBClient,
  rowId: number,
  delayMs: number,
  reason: string
) {
  const nextAttemptAt = Date.now() + delayMs;
  await db.run(
    `UPDATE schedules
     SET status = 'pending', processing_started_at = NULL, send_at = ?
     WHERE id = ?`,
    [nextAttemptAt, rowId]
  );
  console.warn(
    `⚠️ Agendamento ${rowId} adiado para ${new Date(nextAttemptAt).toISOString()}: ${reason}`
  );
}

// ===============================
// ⏱️ AGENDADOR — VERSÃO FINAL, ESTÁVEL E SEM "No LID for user"
// ===============================
const SCHEDULE_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const SCHEDULE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
const SCHEDULE_COORDINATION_TTL_MS = 60 * 1000; // 1 minuto
const SCHEDULE_HEARTBEAT_INTERVAL_MS = 20 * 1000; // 20 segundos
const SCHEDULER_DISPATCH_LOCK_KEY = "scheduler_dispatcher";
const SCHEDULER_WATCHDOG_LOCK_KEY = "scheduler_watchdog";
const SCHEDULE_POLICY_RETRY_DELAY_MS = 60 * 60 * 1000; // 1 hora

let schedulerRunning = false;
let scheduleWatchdogRunning = false;

function startLockHeartbeat(lockKey: string, leaseName: string) {
  let leaseLost = false;

  const timer = setInterval(async () => {
    try {
      const renewed = await renewWorkerLock(lockKey, WORKER_INSTANCE_ID, SCHEDULE_COORDINATION_TTL_MS);
      if (!renewed && !leaseLost) {
        leaseLost = true;
        console.error(`❌ Lease perdido para ${leaseName}; esta instância deixará de coordenar novas execuções.`);
      }
    } catch (err) {
      console.error(`❌ Erro ao renovar lease ${leaseName}:`, err);
    }
  }, SCHEDULE_HEARTBEAT_INTERVAL_MS);

  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

setInterval(async () => {
  if (shuttingDown) return;
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const acquired = await acquireWorkerLock(
      SCHEDULER_DISPATCH_LOCK_KEY,
      WORKER_INSTANCE_ID,
      SCHEDULE_COORDINATION_TTL_MS
    );
    if (!acquired) return;

    const heartbeat = startLockHeartbeat(SCHEDULER_DISPATCH_LOCK_KEY, "agendador");
    const db = getDB();
    const now = Date.now();

    try {
      const schedules = await db.all<ScheduleRow>(
        `SELECT * FROM schedules
         WHERE status = 'pending' AND send_at <= ?`,
        [now]
      );

      const schedulerUserIds = Array.from(
        new Set(schedules.map((row) => row.user_id).filter((id) => Number.isFinite(id)))
      );
      const connectedSessionsByUser = await loadConnectedSessionsByUser(db, schedulerUserIds);
      const notificationUsersById = await loadScheduleNotificationUsers(db, schedulerUserIds);

      for (const row of schedules) {
        try {
          // 🔒 tentativa de lock otimista: só um worker muda status para "processing"
          const claimedAt = Date.now();
          const claimed = await db.run(
            `UPDATE schedules
             SET status = 'processing', processing_started_at = ?
             WHERE id = ? AND status = 'pending'`,
            [claimedAt, row.id]
          );
          if (!claimed.affectedRows) continue; // já foi pego por outro worker

          const campaignRef = `schedule:${row.id}:${claimedAt}`;
          const rawNumbers = JSON.parse(row.numbers || "[]");
          const contactsList: PersonalizedContact[] = buildContactsFromStored(rawNumbers, row.message);
          const userId = row.user_id;
          const notificationUser = notificationUsersById.get(userId) || null;
          let successCount = 0;
          let failureCount = 0;
          let itemLogs: { number: string; status: "sent" | "error"; error?: string; sentAt: number }[] = [];
          const preferredSession = (row as any).preferred_session as string | null;

          // 🔎 Buscar sessões conectadas (com preferência do agendamento)
          const connectedSessions = connectedSessionsByUser.get(userId) || [];
          if (!connectedSessions.length) {
            console.warn("⚠️ Nenhuma sessão conectada para user:", userId);
            await requeueScheduleForLater(
              db,
              row.id,
              SCHEDULE_POLICY_RETRY_DELAY_MS,
              "Nenhuma sessão conectada disponível para este agendamento."
            );
            continue;
          }
          const sessionCandidates = buildSessionCandidates(preferredSession, connectedSessions);

          let safeRowFile: PreparedMediaFile | null = null;
          let storedFilePath: string | null = null;
          if (row.file) {
            const ensured = await ensureScheduleFileOnDisk(db, row as ScheduleRow);
            safeRowFile = ensured.file;
            storedFilePath = ensured.storedPath;
          }

          if (row.file && !safeRowFile) {
            const failureReason =
              "A mídia anexada a este agendamento não está mais disponível no storage configurado. Reenvie o arquivo antes de tentar novamente.";
            console.error(`❌ Agendamento ${row.id} bloqueado: ${failureReason}`);
            await failScheduleDueToMissingMedia(
              db,
              row as ScheduleRow,
              contactsList,
              failureReason,
              notificationUser
            );
            continue;
          }

          const policyResult = await evaluateDispatchPolicy({
            db,
            userId,
            contacts: contactsList,
            campaignKind: "schedule",
            preferredSession,
            scheduledAt: row.send_at,
            plannedCount: contactsList.length,
          });
          await recordSkippedDispatchContacts(db, {
            userId,
            campaignKind: "schedule",
            campaignRef,
            skips: policyResult.skippedContacts,
          });

          const policyWarnings = uniqueWarnings(policyResult.warnings);
          const shouldRetryPolicyBlock = isRetryableDispatchPolicyBlock(
            policyResult.blockReason || "",
            policyResult.skippedContacts.map((skip) => skip.code)
          );

          if (policyResult.blocked && shouldRetryPolicyBlock) {
            await requeueScheduleForLater(
              db,
              row.id,
              SCHEDULE_POLICY_RETRY_DELAY_MS,
              policyResult.blockReason || "Agendamento pausado pela política de envio."
            );
            continue;
          }

          for (const skippedContact of policyResult.skippedContacts) {
            failureCount += 1;
            itemLogs.push({
              number: skippedContact.number,
              status: "error",
              error: skippedContact.reason,
              sentAt: Date.now(),
            });
          }

          const contactsToSend = policyResult.allowedContacts as PersonalizedContact[];
          const listValidation = await runListQualityValidation({
            userId,
            rawNumbers: contactsToSend.map((contact) => contact.number),
            preferredSession,
            connectedSessions,
            unavailableWarning:
              "Nao foi possivel revalidar a qualidade da lista deste agendamento antes do envio.",
          });
          let scheduleWarnings = uniqueWarnings([
            ...policyWarnings,
            ...listValidation.warnings,
          ]);
          if (
            preferredSession &&
            listValidation.sessionName &&
            preferredSession !== listValidation.sessionName
          ) {
            scheduleWarnings.push(
              `A sessao ${preferredSession} nao estava disponivel para validar a lista. A checagem usou ${listValidation.sessionName}.`
            );
          }

          if (listValidation.validation?.blocked) {
            const failureReason =
              listValidation.validation.blockReason ||
              listValidation.validation.recommendation ||
              "Agendamento bloqueado por baixa qualidade da lista.";
            const processedAt = Date.now();
            const failedLogs = contactsToSend.map((contact) => ({
              number: contact.number,
              status: "error" as const,
              error: failureReason,
              sentAt: processedAt,
            }));

            await db.run(
              `UPDATE schedules SET status = 'failed', processing_started_at = NULL WHERE id = ?`,
              [row.id]
            );
            await insertScheduleExecutionLog(
              db,
              row as ScheduleRow,
              0,
              itemLogs.length + failedLogs.length,
              [...itemLogs, ...failedLogs],
              processedAt
            );
            console.warn(`⚠️ Agendamento ${row.id} bloqueado por baixa qualidade da lista: ${failureReason}`);
            continue;
          }

          let sessionUsed: string | null = null;
          let lastSendError: any = policyResult.blocked
            ? policyResult.blockReason || "Nenhum contato elegível para este agendamento."
            : null;
          let nextContactIndex = 0;
          let consecutiveFailures = 0;
          let campaignPauseReason: string | null = null;
          scheduleWarnings = uniqueWarnings(scheduleWarnings);

          for (const shortName of sessionCandidates) {
            const sessionThrottleKey = `USER${userId}_${shortName}`;
            const client = getClient(sessionThrottleKey);
            if (!client) continue;

            const sessionHealth = await evaluateDispatchSessionHealth({
              db,
              userId,
              sessionName: shortName,
            });
            scheduleWarnings = uniqueWarnings([...scheduleWarnings, ...sessionHealth.warnings]);
            if (sessionHealth.blocked) {
              lastSendError = sessionHealth.reason;
              continue;
            }

            const sessionRisk = await evaluateDispatchCampaignRisk({
              db,
              userId,
              sessionName: shortName,
              plannedCount: contactsToSend.length - nextContactIndex,
              scheduledAt: row.send_at,
            });
            scheduleWarnings = uniqueWarnings([...scheduleWarnings, ...sessionRisk.warnings]);
            if (sessionRisk.blocked) {
              lastSendError = sessionRisk.reason;
              continue;
            }

            let sessionRateLimited = false;

            for (
              let contactIndex = nextContactIndex;
              contactIndex < contactsToSend.length;
              contactIndex += 1
            ) {
              const contact = contactsToSend[contactIndex];
              try {
                assertSessionCanSend(sessionThrottleKey);

                // ✅ valida número (SEM @c.us)
                const target = await ensureChat(client, contact.number);
                const finalMessage = renderTemplate(contact.message ?? row.message ?? "", contact);

                if (safeRowFile) {
                  // 📎 MÍDIA
                  await withTimeout(
                    client.sendFile(
                      target,
                      safeRowFile.content,
                      safeRowFile.filename,
                      finalMessage || ""
                    ),
                    WPP_TIMEOUT_MS,
                    "sendFile"
                  );
                } else if (finalMessage) {
                  // 💬 TEXTO — MÉTODO CORRETO
                  await withTimeout(client.sendText(target, finalMessage), WPP_TIMEOUT_MS, "sendText");
                } else {
                  throw new Error("Mensagem vazia e mídia inválida");
                }
                sessionUsed = sessionUsed || shortName;
                successCount += 1;
                consecutiveFailures = 0;
                nextContactIndex = contactIndex + 1;
                itemLogs.push({ number: contact.number, status: "sent", sentAt: Date.now() });
                await recordDispatchContactEvent(
                  {
                    userId,
                    sessionName: shortName,
                    campaignKind: "schedule",
                    campaignRef,
                    phone: contact.number,
                    status: "sent",
                  },
                  db
                );

                recordSessionSend(sessionThrottleKey);

                if (nextContactIndex < contactsToSend.length) {
                  await sleep(getHumanDelay(sessionThrottleKey));
                }

              } catch (err: any) {
                if (err instanceof SessionRateLimitError) {
                  sessionRateLimited = true;
                  lastSendError = err.message;
                  console.warn(
                    "⚠️ Limite conservador de envio atingido na sessão:",
                    sessionThrottleKey,
                    err.message
                  );
                  break;
                }

                const classified = classifyDispatchError(err);
                console.error(
                  "⚠️ Erro envio agendado (número):",
                  contact.number,
                  err?.message || err
                );
                failureCount += 1;
                consecutiveFailures += 1;
                nextContactIndex = contactIndex + 1;
                itemLogs.push({
                  number: contact.number,
                  status: "error",
                  error: classified.message,
                  sentAt: Date.now(),
                });
                lastSendError = classified.message;
                await recordDispatchContactEvent(
                  {
                    userId,
                    sessionName: shortName,
                    campaignKind: "schedule",
                    campaignRef,
                    phone: contact.number,
                    status: "error",
                    errorCode: classified.code,
                    errorMessage: classified.message,
                  },
                  db
                );

                const runtimePauseReason = getCampaignPauseReason({
                  sessionName: shortName,
                  processed: successCount + failureCount,
                  failures: failureCount,
                  consecutiveFailures,
                });
                if (runtimePauseReason) {
                  campaignPauseReason = runtimePauseReason;
                  lastSendError = runtimePauseReason;
                  scheduleWarnings = uniqueWarnings([...scheduleWarnings, runtimePauseReason]);
                  break;
                }
              }
            }

            if (campaignPauseReason) {
              break;
            }

            if (nextContactIndex >= contactsToSend.length) {
              break;
            }

            if (sessionRateLimited) continue;
          }

          const retryableNoProgress =
            nextContactIndex === 0 &&
            isRetryableDispatchPolicyBlock(
              String(campaignPauseReason || lastSendError || "")
            );

          if (retryableNoProgress) {
            await requeueScheduleForLater(
              db,
              row.id,
              SCHEDULE_POLICY_RETRY_DELAY_MS,
              String(lastSendError || "Agendamento pausado temporariamente pelas regras de envio.")
            );
            continue;
          }

          if (nextContactIndex < contactsToSend.length) {
            const remainingError = String(
              campaignPauseReason ||
              lastSendError ||
              "Nenhuma sessão disponível para concluir o envio"
            );

            for (
              let contactIndex = nextContactIndex;
              contactIndex < contactsToSend.length;
              contactIndex += 1
            ) {
              const contact = contactsToSend[contactIndex];
              failureCount += 1;
              itemLogs.push({
                number: contact.number,
                status: "error",
                error: remainingError,
                sentAt: Date.now(),
              });
              await recordDispatchContactEvent(
                {
                  userId,
                  sessionName: sessionUsed,
                  campaignKind: "schedule",
                  campaignRef,
                  phone: contact.number,
                  status: "skipped",
                  errorCode: campaignPauseReason ? "campaign_paused" : "no_session",
                  errorMessage: remainingError,
                },
                db
              );
            }
          }

          if (!sessionUsed && itemLogs.length) {
            sessionUsed = preferredSession || sessionCandidates[0] || "__processed__";
          }

          if (!sessionUsed) {
            console.warn("⚠️ Nenhuma sessão conseguiu enviar o agendamento:", row.id, sessionCandidates);
            await requeueScheduleForLater(
              db,
              row.id,
              SCHEDULE_POLICY_RETRY_DELAY_MS,
              String(lastSendError || "Nenhuma sessão conseguiu concluir o envio do agendamento.")
            );
            continue;
          }

          // ✅ MARCAR COMO ENVIADO
          await db.run(
            `UPDATE schedules SET status = 'sent', processing_started_at = NULL WHERE id = ?`,
            [row.id]
          );

          const recurrence = (row as any).recurrence || "none";
          const recurrenceEnd = (row as any).recurrence_end || null;
          const nextSendAt = calculateNextSendAt(row.send_at, recurrence, recurrenceEnd);

          // 📝 Registrar log de execução
          const sentAt = Date.now();
          await insertScheduleExecutionLog(db, row as ScheduleRow, successCount, failureCount, itemLogs, sentAt);

          // 📧 Notificação por e-mail (best-effort)
          try {
            const user = notificationUser;

            if (user?.email) {
              const subject = `Agendamento #${row.id} concluído`;
              const successLine = `<li>Sucesso: <b>${successCount}</b></li>`;
              const failureLine = `<li>Falhas: <b>${failureCount}</b></li>`;
              const nextLine = nextSendAt
                ? `<p>Próximo envio agendado para ${new Date(nextSendAt).toLocaleString("pt-BR")}</p>`
                : "";
              const html = `
                <p>Olá ${user.name || ""},</p>
                <p>Seu agendamento #${row.id} foi concluído em ${new Date(sentAt).toLocaleString("pt-BR")}.</p>
                <ul>${successLine}${failureLine}</ul>
                ${nextLine}
                <p>Mensagem: ${row.message ? row.message.substring(0, 120) : "(sem texto)"}${row.message && row.message.length > 120 ? "..." : ""}</p>
              `;

              await sendEmail(user.email, subject, html);
            }
          } catch (err: any) {
            console.error("⚠️ Falha ao enviar notificação de agendamento:", err?.message || err);
          }

          if (nextSendAt) {
            const nextFilePath = storedFilePath ?? null;
            const nextFilename = safeRowFile?.filename ?? row.filename ?? null;
            await db.run(
              `INSERT INTO schedules (user_id, numbers, message, file, filename, preferred_session, send_at, recurrence, recurrence_end)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [userId, row.numbers, row.message, nextFilePath, nextFilename, preferredSession ?? null, nextSendAt, recurrence, recurrenceEnd]
            );
          }

          if (scheduleWarnings.length) {
            console.warn("⚠️ Alertas de política no agendamento:", row.id, scheduleWarnings);
          }
          console.log("✅ Agendamento enviado:", row.id);

        } catch (err) {
          console.error("❌ Erro geral no agendador:", err);
          // devolve para pending para tentar novamente depois
          try {
            await getDB().run(
              `UPDATE schedules SET status = 'pending', processing_started_at = NULL WHERE id = ? AND status = 'processing'`,
              [row.id]
            );
          } catch { }
        }
      }

    } finally {
      heartbeat.stop();
      try {
        await releaseWorkerLock(SCHEDULER_DISPATCH_LOCK_KEY, WORKER_INSTANCE_ID);
      } catch (err) {
        console.error("❌ Erro ao liberar lease do agendador:", err);
      }
    }
  } catch (err) {
    console.error("❌ Erro crítico no loop do agendador:", err);
  } finally {
    schedulerRunning = false;
  }
}, 10000);

// 🛡️ Watchdog para destravar agendamentos travados em "processing"
setInterval(async () => {
  if (shuttingDown) return;
  if (scheduleWatchdogRunning) return;

  scheduleWatchdogRunning = true;
  try {
    const acquired = await acquireWorkerLock(
      SCHEDULER_WATCHDOG_LOCK_KEY,
      WORKER_INSTANCE_ID,
      SCHEDULE_COORDINATION_TTL_MS
    );
    if (!acquired) return;

    const heartbeat = startLockHeartbeat(SCHEDULER_WATCHDOG_LOCK_KEY, "watchdog de agendamentos");
    try {
      const db = getDB();
      const timeoutThreshold = Date.now() - SCHEDULE_PROCESSING_TIMEOUT_MS;

      const reset = await db.run(
        `UPDATE schedules
         SET status = 'pending', processing_started_at = NULL
         WHERE status = 'processing' AND (processing_started_at IS NULL OR processing_started_at <= ?)`,
        [timeoutThreshold]
      );

      if (reset.affectedRows) {
        console.warn(`🔁 Watchdog: ${reset.affectedRows} agendamento(s) reaberto(s) para pending`);
      }
    } finally {
      heartbeat.stop();
      try {
        await releaseWorkerLock(SCHEDULER_WATCHDOG_LOCK_KEY, WORKER_INSTANCE_ID);
      } catch (err) {
        console.error("❌ Erro ao liberar lease do watchdog:", err);
      }
    }
  } catch (err) {
    console.error("❌ Erro no watchdog de agendamentos:", err);
  } finally {
    scheduleWatchdogRunning = false;
  }
}, SCHEDULE_WATCHDOG_INTERVAL_MS);

// 🔄 Atualizar pipeline
// Atualizar estágio do CRM Kanban
app.post("/api/crm/stage", authMiddleware, subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const { id, stage } = req.body;
    const db = getDB();

    await db.run(
      `UPDATE crm SET stage = ? WHERE id = ? AND user_id = ?`,
      [stage, id, user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

// =============================
// ➕ ADICIONAR TAG (CORRIGIDO)
// =============================
app.post("/api/crm/tag", authMiddleware, subscriptionGuard, async (req, res) => {
  try {
    const db = getDB();
    const { id, tag } = req.body;

    if (!id || !tag)
      return res.status(400).json({ ok: false, error: "ID e tag obrigatórios" });

    const row = await db.get(`SELECT tags FROM crm WHERE id = ?`, [id]);
    let tags = [];

    try {
      tags = row?.tags ? JSON.parse(row.tags) : [];
    } catch {
      tags = [];
    }

    tags.push(tag);

    await db.run(
      `UPDATE crm SET tags = ? WHERE id = ?`,
      [JSON.stringify(tags), id]
    );

    res.json({ ok: true, tags });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Erro ao salvar tag" });
  }
});

// =============================
// 📝 ADICIONAR NOTA
// =============================
app.post("/api/crm/note", authMiddleware, subscriptionGuard, async (req, res) => {
  const { id, text } = req.body;
  if (!id || !text) return res.status(400).json({ ok: false, error: "Dados faltando" });

  try {
    const db = getDB();
    const client = await db.get(`SELECT notes FROM crm WHERE id = ?`, [id]);

    let notes = [];
    try { notes = JSON.parse(client?.notes || "[]"); } catch { }

    const note = {
      text,
      created_at: Date.now()
    };

    notes.unshift(note);

    await db.run(`UPDATE crm SET notes = ? WHERE id = ?`, [
      JSON.stringify(notes),
      id
    ]);

    return res.json({ ok: true, notes });
  } catch (err) {
    console.log("Erro ao salvar nota:", err);
    return res.status(500).json({ ok: false });
  }
});


// Criar cliente
app.post("/api/crm/create", authMiddleware, subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();

    const { name, phone, citystate, stage, tags, notes, deal_value, follow_up_date } = req.body;
    const phoneRaw = String(phone ?? "").trim();

    const result = await db.run(
      `INSERT INTO crm (user_id, name, phone, citystate, stage, tags, notes, deal_value, follow_up_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        name,
        phoneRaw,
        citystate || "",
        stage || "Novo",
        tags || "[]",
        notes || "[]",
        Number(deal_value) || 0,
        follow_up_date ? Number(follow_up_date) : null
      ]
    );

    const newId = (result as any)?.lastID;
    io.to(`user:${user.id}`).emit("crm:changed", { type: "create", id: newId });
    res.json({ ok: true, id: newId });
  } catch (err) {
    console.error("❌ Erro criar CRM:", err);
    res.status(500).json({ ok: false });
  }
});


// Deletar cliente
app.delete("/api/crm/delete/:id", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { id } = req.params;

    if (!id) return res.status(400).json({ ok: false, error: "ID ausente" });

    const db = getDB();

    // Garante que só o dono pode deletar
    const existing = await db.get(
      `SELECT id FROM crm WHERE id = ? AND user_id = ?`,
      [id, user.id]
    );

    if (!existing) {
      return res.status(404).json({ ok: false, error: "Cliente não encontrado" });
    }

    await db.run(`DELETE FROM crm WHERE id = ? AND user_id = ?`, [id, user.id]);

    io.to(`user:${user.id}`).emit("crm:changed", { type: "delete", id: Number(id) });
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro ao deletar cliente CRM:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

// Atualizar cliente
app.put("/api/crm/update", authMiddleware, async (req, res) => {
  try {
    const db = getDB();

    const { id, name, phone, citystate, stage, tags, notes, deal_value, follow_up_date } = req.body;
    const phoneRaw = String(phone ?? "").trim();

    if (!id) return res.json({ ok: false, error: "ID ausente" });

    await db.run(
      `UPDATE crm 
       SET name = ?, phone = ?, citystate = ?, stage = ?, tags = ?, notes = ?, deal_value = ?, follow_up_date = ?
       WHERE id = ?`,
    [
      name,
      phoneRaw,
      citystate || "",
      stage || "Novo",
      tags || "[]",
      notes || "[]",
      Number(deal_value) || 0,
      follow_up_date ? Number(follow_up_date) : null,
      id
      ]
    );

    io.to(`user:${(req as any).user.id}`).emit("crm:changed", { type: "update", id });
    res.json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

// ===============================
// 🔁 FLUXOS INTELIGENTES (CRUD)
// ===============================
app.get("/fluxos", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("fluxos", { user });
});

app.get("/fallback-settings", authMiddleware, subscriptionGuard, (req, res) => {
  const user = (req as any).user;
  res.render("fallbackSettings", { user });
});

// Listar fluxos do usuário
app.get("/api/flows/list", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const rows = await db.all(`SELECT * FROM flows WHERE user_id = ? ORDER BY id DESC`, [user.id]);
    res.json({ ok: true, flows: rows });
  } catch (err) {
    console.error("Erro listar flows:", err);
    res.status(500).json({ ok: false });
  }
});

  // Criar flow
  app.post("/api/flows/create", authMiddleware, subscriptionGuard, async (req, res) => {
    try {
      const user = (req as any).user;
      const { name, trigger, triggers, actions, priority, active } = req.body;

      const trigList =
        Array.isArray(triggers) && triggers.length
          ? triggers
          : (trigger ? [trigger] : []);

      if (!name || !trigList.length || !actions) {
        return res.status(400).json({ ok: false, error: "Dados incompletos" });
      }

      const db = getDB();
      await db.run(
        `INSERT INTO flows (user_id, name, trigger_type, actions, triggers, priority, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user.id, name, trigList[0], JSON.stringify(actions), JSON.stringify(trigList), Number(priority) || 0, (active === 0 || active === false) ? 0 : 1]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("Erro criar flow:", err);
      res.status(500).json({ ok: false });
  }
});

  // Atualizar flow
  app.put("/api/flows/update", authMiddleware, async (req, res) => {
    try {
      const user = (req as any).user;
      const { id, name, trigger, triggers, actions, priority, active } = req.body;

      const trigList =
        Array.isArray(triggers) && triggers.length
          ? triggers
          : (trigger ? [trigger] : []);

      if (!id || !name || !trigList.length || !actions) {
        return res.status(400).json({ ok: false, error: "Dados incompletos" });
      }

      const db = getDB();
      await db.run(
        `UPDATE flows
     SET name = ?, trigger_type = ?, actions = ?, triggers = ?, priority = ?, active = ?
     WHERE id = ? AND user_id = ?`,
        [name, trigList[0], JSON.stringify(actions), JSON.stringify(trigList), Number(priority) || 0, (active === 0 || active === false) ? 0 : 1, id, user.id]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("Erro atualizar flow:", err);
      res.status(500).json({ ok: false });
  }
});

// Deletar flow
app.delete("/api/flows/delete", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false });
    const db = getDB();
    await db.run(`DELETE FROM flows WHERE id = ? AND user_id = ?`, [id, user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro deletar flow:", err);
    res.status(500).json({ ok: false });
  }
});

// Ativar / desativar flow
app.put("/api/flows/active", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { id, active } = req.body;
    if (!id || active === undefined) return res.status(400).json({ ok: false, error: "id e active são obrigatórios" });
    const db = getDB();
    await db.run(
      `UPDATE flows SET active = ? WHERE id = ? AND user_id = ?`,
      [active ? 1 : 0, id, user.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao alternar flow:", err);
    return res.status(500).json({ ok: false });
  }
});

// Testar flow (simulação)
app.post("/api/flows/test", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { id, message, chatId, sessionName, contactName } = req.body;
    if (!id || !message) return res.status(400).json({ ok: false, error: "id e message são obrigatórios" });

    const db = getDB();
    const flow = await db.get<any>(
      `SELECT * FROM flows WHERE id = ? AND user_id = ?`,
      [id, user.id]
    );
    if (!flow) return res.status(404).json({ ok: false, error: "Flow não encontrado" });

    const phone = (chatId || "TEST").replace(/@.*/, "");
    const tzRow = await db.get<any>(`SELECT timezone_offset FROM users WHERE id = ?`, [user.id]);
    const offsetMinutes = Number(tzRow?.timezone_offset ?? -180);
    const now = new Date(Date.now() + offsetMinutes * 60000);
    const localHour = now.getHours();

    let crmForFlow: { stage?: string | null; tags?: string[] } | undefined;
    try {
      const row = await db.get<{ stage: string | null; tags: string | null }>(
        `SELECT stage, tags FROM crm WHERE user_id = ? AND phone = ?`,
        [user.id, phone]
      );
      crmForFlow = {
        stage: row?.stage ?? null,
        tags: row?.tags ? JSON.parse(row.tags) : [],
      };
    } catch { }

    const ctx = {
      userId: user.id,
      sessionName: sessionName || "TEST",
      chatId: chatId || `${phone}@c.us`,
      messageBody: String(message),
      client: {}, // não usado em simulação
      crm: crmForFlow,
      localHour,
      isFirstMessage: true,
      contactName: contactName || phone,
      phone,
      localDateStr: now.toLocaleDateString("pt-BR"),
      localTimeStr: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      lastResponse: undefined,
    };

    const result = await simulateFlowRun(flow, ctx);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Erro testar flow:", err);
    res.status(500).json({ ok: false });
  }
});

// ===============================
// 🤝 Fluxo de boas-vindas (primeiro contato)
// ===============================
app.get("/api/welcome-flow", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const flow = await db.get<any>(
      `SELECT * FROM welcome_flows WHERE user_id = ? LIMIT 1`,
      [user.id]
    );
    return res.json({ ok: true, flow: flow || null });
  } catch (err) {
    console.error("Erro ao buscar welcome flow:", err);
    return res.status(500).json({ ok: false });
  }
});

app.post("/api/welcome-flow", authMiddleware, subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const { name, actions, active } = req.body;

    if (!name || !actions) {
      return res.status(400).json({ ok: false, error: "Nome e ações são obrigatórios" });
    }

    let actionsJson = "";
    try {
      actionsJson = JSON.stringify(actions);
    } catch {
      return res.status(400).json({ ok: false, error: "Ações inválidas" });
    }

    const db = getDB();
    const existing = await db.get<{ id: number }>(
      `SELECT id FROM welcome_flows WHERE user_id = ? LIMIT 1`,
      [user.id]
    );

    if (existing?.id) {
      await db.run(
        `UPDATE welcome_flows SET name = ?, actions = ?, active = ? WHERE id = ? AND user_id = ?`,
        [name, actionsJson, active ? 1 : 0, existing.id, user.id]
      );
    } else {
      await db.run(
        `INSERT INTO welcome_flows (user_id, name, actions, active)
         VALUES (?, ?, ?, ?)`,
        [user.id, name, actionsJson, active ? 1 : 0]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar welcome flow:", err);
    return res.status(500).json({ ok: false });
  }
});

app.post("/api/welcome-flow/test", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { message, contactName, phone } = req.body;
    const db = getDB();
    const flow = await db.get<any>(
      `SELECT * FROM welcome_flows WHERE user_id = ? AND active = 1 LIMIT 1`,
      [user.id]
    );
    if (!flow) return res.status(404).json({ ok: false, error: "Nenhum fluxo configurado" });

    const actions = JSON.parse(flow.actions || "[]");
    const tzRow = await db.get<any>(`SELECT timezone_offset FROM users WHERE id = ?`, [user.id]);
    const offsetMinutes = Number(tzRow?.timezone_offset ?? -180);
    const now = new Date(Date.now() + offsetMinutes * 60000);

    const ctx = {
      userId: user.id,
      sessionName: "TEST",
      chatId: `${phone || "11999999999"}@c.us`,
      messageBody: String(message || "Olá, tudo bem?"),
      client: {}, // não usado em simulação
      crm: { stage: "Novo", tags: [] },
      localHour: now.getHours(),
      isFirstMessage: true,
      contactName: contactName || "Contato teste",
      phone: phone || "11999999999",
      localDateStr: now.toLocaleDateString("pt-BR"),
      localTimeStr: now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      lastResponse: undefined,
    };

    const result = await simulateWelcomeFlow(actions, ctx as any);
    return res.json({ ok: true, logs: result.logs });
  } catch (err) {
    console.error("Erro ao testar welcome flow:", err);
    return res.status(500).json({ ok: false });
  }
});

// ===============================
// ⚙️ Configuração de fallback IA → humano
// ===============================
const toStringArray = (value: any, fallback: string[]) => {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const items = value
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (items.length) return items;
  }
  return fallback;
};

const toBool = (value: any, fallback: boolean) => {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value === "string") {
    const norm = value.toLowerCase();
    if (["true", "on", "yes"].includes(norm)) return true;
    if (["false", "off", "no"].includes(norm)) return false;
  }
  return fallback;
};

const toNumber = (value: any, fallback: number | null) => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toStringOrNull = (value: any, fallback: string | null) => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text.length) return null;
  return text;
};

app.get("/api/fallback-settings", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const sessionName = String(req.query.sessionName || "").trim();

    if (!sessionName) {
      return res.status(400).json({ ok: false, error: "sessionName é obrigatório" });
    }

    const config = await loadFallbackSettings(user.id, sessionName);
    return res.json({ ok: true, config });
  } catch (err) {
    console.error("Erro ao buscar fallback-settings:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

app.get("/api/sessions", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const sessions = await db.all(
      `SELECT session_name, status
       FROM sessions
       WHERE user_id = ?
       ORDER BY (status = 'connected') DESC, id DESC`,
      [user.id]
    );
    return res.json({ ok: true, sessions });
  } catch (err) {
    console.error("Erro ao listar sessões:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

app.get("/api/fallback-settings/list", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const rows = await db.all(
      `SELECT session_name, enable_fallback, notify_panel, notify_webhook, alert_phone, alert_message, updated_at
       FROM fallback_settings
       WHERE user_id = ?
       ORDER BY updated_at DESC, session_name ASC`,
      [user.id]
    );
    return res.json({ ok: true, items: rows || [] });
  } catch (err) {
    console.error("Erro ao listar fallback-settings:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

app.post("/api/fallback-settings", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const sessionName = String(req.body?.sessionName || req.query.sessionName || "").trim();

    if (!sessionName) {
      return res.status(400).json({ ok: false, error: "sessionName é obrigatório" });
    }

    const current = await loadFallbackSettings(user.id, sessionName);

    const sensitivityRaw = String(req.body?.fallbackSensitivity || current.fallbackSensitivity).toLowerCase();
    const fallbackSensitivity = ["low", "medium", "high"].includes(sensitivityRaw)
      ? (sensitivityRaw as FallbackSettings["fallbackSensitivity"])
      : current.fallbackSensitivity;

    const payload: FallbackSettings = {
      enableFallback: toBool(req.body?.enableFallback, current.enableFallback),
      fallbackMessage:
        req.body?.fallbackMessage === undefined
          ? current.fallbackMessage
          : String(req.body?.fallbackMessage ?? ""),
      sendTransferMessage: toBool(req.body?.sendTransferMessage, current.sendTransferMessage),
      internalNoteOnly: toBool(req.body?.internalNoteOnly, current.internalNoteOnly),
      fallbackSensitivity,
      maxRepetitions: toNumber(req.body?.maxRepetitions, current.maxRepetitions) ?? current.maxRepetitions,
      maxFrustration: toNumber(req.body?.maxFrustration, current.maxFrustration) ?? current.maxFrustration,
      maxIaFailures: toNumber(req.body?.maxIaFailures, current.maxIaFailures) ?? current.maxIaFailures,
      triggerWords: toStringArray(req.body?.triggerWords, current.triggerWords),
      frustrationWords: toStringArray(req.body?.frustrationWords, current.frustrationWords),
      aiUncertaintyPhrases: toStringArray(req.body?.aiUncertaintyPhrases, current.aiUncertaintyPhrases),
      aiTransferPhrases: toStringArray(req.body?.aiTransferPhrases, current.aiTransferPhrases),
      humanModeDuration:
        req.body?.humanModeDuration === undefined
          ? current.humanModeDuration
          : toNumber(req.body?.humanModeDuration, current.humanModeDuration),
      notifyPanel: toBool(req.body?.notifyPanel, current.notifyPanel),
      notifyWebhook: toBool(req.body?.notifyWebhook, current.notifyWebhook),
      webhookUrl: String(req.body?.webhookUrl ?? current.webhookUrl),
      alertPhone: toStringOrNull(req.body?.alertPhone, current.alertPhone || null),
      alertMessage: toStringOrNull(req.body?.alertMessage, current.alertMessage || null) ?? current.alertMessage,
      fallbackCooldownMinutes:
        req.body?.fallbackCooldownMinutes === undefined
          ? current.fallbackCooldownMinutes
          : toNumber(req.body?.fallbackCooldownMinutes, current.fallbackCooldownMinutes),
    };

    if (payload.internalNoteOnly) {
      payload.sendTransferMessage = false;
    }

    const saved = await saveFallbackSettings(user.id, sessionName, payload);
    resetFallbackCache(user.id, sessionName); // garante recarga futura caso outro processo esteja usando
    await loadFallbackSettings(user.id, sessionName); // recarrega imediatamente o cache local

    return res.json({ ok: true, config: saved });
  } catch (err) {
    console.error("Erro ao salvar fallback-settings:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

app.delete("/api/fallback-settings", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const sessionName = String(req.body?.sessionName || req.query.sessionName || "").trim();

    if (!sessionName) {
      return res.status(400).json({ ok: false, error: "sessionName é obrigatório" });
    }

    const db = getDB();
    await db.run(`DELETE FROM fallback_settings WHERE user_id = ? AND session_name = ?`, [user.id, sessionName]);
    resetFallbackCache(user.id, sessionName);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar fallback-settings:", err);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});




// =======================================
// 🔥 API de Usuário e Sessões
// =======================================

// Registro
const REGISTRATION_GENERIC_ERROR = "Não foi possível criar sua conta. Entre em contato com o suporte.";
const IP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeEmail(rawEmail: string): string {
  const email = String(rawEmail || "").trim().toLowerCase();
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return email;

  const withoutAlias = localPart.split("+")[0];
  const domainsWithoutDots = new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "outlook.com.br",
    "hotmail.com",
    "hotmail.com.br",
    "live.com",
    "live.com.br",
    "msn.com",
  ]);

  const cleanedLocal = domainsWithoutDots.has(domain)
    ? withoutAlias.replace(/\./g, "")
    : withoutAlias;

  return `${cleanedLocal}@${domain}`;
}

function getClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = raw?.toString().split(",")[0].trim() || req.socket?.remoteAddress || null;
  if (!ip) return null;
  return ip.replace(/^::ffff:/, "");
}

const shortDeviceId = (deviceId?: string | null) =>
  deviceId ? deviceId.slice(0, 8) : null;

app.post("/register", registerLimiter, async (req, res) => {
  const { name, email, password, prompt } = req.body;
  const deviceId: string = typeof req.body?.deviceId === "string" ? req.body.deviceId.trim() : "";
  if (requireFields(res, { name, email, password })) return;

  const db = getDB();
  const normalizedEmail = normalizeEmail(email);
  const ip = getClientIp(req);
  const now = Date.now();
  const trialDays = 7;

  try {
    const existingUsers = await db.all<{ id: number; email: string; email_normalized: string | null }>(
      `SELECT id, email, email_normalized FROM users WHERE email = ? OR email_normalized = ?`,
      [email, normalizedEmail]
    );

    const conflict = existingUsers.find((row) => {
      const storedNorm = row.email_normalized || normalizeEmail(row.email);
      return storedNorm === normalizedEmail;
    });

    if (conflict) {
      console.warn("register_block_email", {
        reason: "email_normalized_conflict",
        ip,
        deviceId: shortDeviceId(deviceId),
      });
      return res.status(400).json({ error: REGISTRATION_GENERIC_ERROR });
    }

    if (ip) {
      const limitRow = await db.get<{ total: number }>(
        `
        SELECT COUNT(DISTINCT user_id) AS total
        FROM ip_registrations
        WHERE ip = ?
          AND created_at >= ?
        `,
        [ip, now - IP_WINDOW_MS]
      );
      const ipTotal = Number(limitRow?.total || 0);
      if (ipTotal >= 3) {
        console.warn("register_block_ip", {
          reason: "ip_limit",
          ip,
          deviceId: shortDeviceId(deviceId),
          total: ipTotal,
        });
        return res.status(400).json({ error: REGISTRATION_GENERIC_ERROR });
      }
    }

    let deviceRow: { account_count: number; blocked: number; block_reason?: string; first_seen_at?: number } | null = null;

    if (deviceId) {
      deviceRow = await db.get(
        `SELECT account_count, blocked, block_reason, first_seen_at FROM device_fingerprints WHERE device_id = ?`,
        [deviceId]
      );

      if (deviceRow?.blocked) {
        console.warn("register_block_device", {
          reason: "device_blocked",
          ip,
          deviceId: shortDeviceId(deviceId),
          blockReason: deviceRow.block_reason,
        });
        return res.status(400).json({ error: REGISTRATION_GENERIC_ERROR });
      }
    }

    const hash = await bcrypt.hash(password, 10);
    const session = createSessionToken(now);

    const userResult = await db.run(
      `INSERT INTO users (
        name, email, email_normalized, password, prompt, token, token_expires_at,
        plan, subscription_status, plan_expires_at, trial_started_at,
        email_verified, email_verify_token, email_verify_expires,
        signup_device_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        email,
        normalizedEmail,
        hash,
        prompt || "",
        session.token,
        session.expiresAt,
        "free",
        "trial",
        now + trialDays * 24 * 60 * 60 * 1000,
        now,

        0, // email_verified
        null,
        null,
        deviceId || null,
      ]
    );

    const userId = Number(userResult.insertId || 0);
    if (!userId) {
      console.error("register_insert_missing_id", { ip, deviceId: shortDeviceId(deviceId) });
      return res.status(400).json({ error: REGISTRATION_GENERIC_ERROR });
    }

    if (deviceId) {
      const nextCount = (deviceRow?.account_count || 0) + 1;
      await db.run(
        `
        INSERT INTO device_fingerprints (
          device_id, user_id, account_count, blocked, block_reason, first_seen_at, last_seen_at
        )
        VALUES (?, ?, 1, 0, NULL, ?, ?)
        ON DUPLICATE KEY UPDATE
          user_id = VALUES(user_id),
          account_count = device_fingerprints.account_count + 1,
          last_seen_at = VALUES(last_seen_at)
        `,
        [deviceId, userId, deviceRow?.first_seen_at ?? now, now]
      );

      if (nextCount >= 2) {
        console.warn("register_device_multiple_accounts", {
          reason: "device_multiple_accounts",
          ip,
          deviceId: shortDeviceId(deviceId),
          accounts: nextCount,
        });
      }
    }

    if (ip) {
      await db.run(
        `INSERT INTO ip_registrations (ip, user_id, created_at) VALUES (?, ?, ?)`,
        [ip, userId, now]
      );
    }

    // 🔥 enviar email com token + salvar no banco
    try {
      await sendVerifyEmail(userId);
    } catch (err) {
      console.error("❌ Erro ao enviar email:", err);
    }

    return res.json({
      ok: true,
      message: "Cadastro realizado! Verifique seu e-mail para ativar a conta."
    });
  } catch (err) {
    console.error("Erro no registro:", err);
    return res.status(400).json({ error: REGISTRATION_GENERIC_ERROR });
  }
});

// Login
app.post("/auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (requireFields(res, { email, password })) return;

  const db = getDB();

  const user = await db.get<any>(
    "SELECT * FROM users WHERE email = ?",
    [email]
  );

  // 🔒 nunca diga se o email existe ou não
  if (!user) {
    return res.status(401).json({ error: "E-mail ou senha inválidos" });
  }

  const ok = await bcrypt.compare(password, user.password);

  if (!ok) {
    return res.status(401).json({ error: "E-mail ou senha inválidos" });
  }

  // 🔐 Rotaciona o token a cada login para invalidar vazamentos antigos
  const session = await issueUserSession(user.id);

  // ✅ SEMPRE cria o cookie quando login estiver correto
  setAuthCookie(res, session.token);

  const emailVerified = Number(user.email_verified) === 1;

  // 🔥 se não verificou, redireciona mas mantém login ativo
  if (!emailVerified) {
    return res.status(403).json({
      error: "Confirme seu e-mail antes de acessar.",
      redirect: "/verify-email-required"
    });
  }

  return res.json({ ok: true });
});

// =======================================
// 🚪 LOGOUT
// =======================================
app.post("/auth/logout", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    // invalida imediatamente o token atual
    await invalidateUserSession(user.id);
  } catch (err) {
    console.error("Erro ao rotacionar token no logout:", err);
    // continua para limpar cookie mesmo assim
  }

  clearAuthCookie(res);

  return res.json({ ok: true });
});

// =======================================
// 🔄 Rotacionar token manualmente (logout global)
// =======================================
app.post("/auth/rotate-token", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const session = await issueUserSession(user.id);

    setAuthCookie(res, session.token);

    // retorna para uso em integrações se o cliente quiser
    return res.json({ ok: true, token: session.token, expiresAt: session.expiresAt });
  } catch (err) {
    console.error("Erro ao rotacionar token:", err);
    return res.status(500).json({ ok: false, error: "Erro interno ao rotacionar token" });
  }
});


app.post("/user/update-prompt", authMiddleware, async (req, res) => {
  const { prompt } = req.body;

  const user = (req as any).user; // vem do cookie
  const db = getDB();

  await db.run(
    `UPDATE users SET prompt = ? WHERE id = ?`,
    [prompt || "", user.id]
  );

  await logAudit("prompt_update", user.id, "user", user.id, { length: (prompt || "").length });

  res.json({ ok: true });
});

// Criar Sessão
app.post(
  "/sessions/create",
  authMiddleware,
  subscriptionGuard,
  async (req, res) => {
    const { sessionName } = req.body;
    if (!sessionName) {
      return res.status(400).json({ error: "sessionName é obrigatório" });
    }

    const user = (req as any).user;
    const db = getDB();

    // ===============================
    // 🔐 LIMITE DE SESSÕES POR PLANO
    // ===============================
    const row = await db.get<{ total: number | string }>(
      `SELECT COUNT(*) as total FROM sessions WHERE user_id = ?`,
      [user.id]
    );

    const totalSessions = Number(row?.total || 0);
    const planConfig = await getPlanConfig(user.plan);
    const maxSessions = planConfig?.maxSessions ?? 0;

    if (totalSessions >= maxSessions) {
      let message = "Limite de sessões atingido.";
      const displayName = planConfig?.displayName || String(user.plan || "seu plano");
      message = `O plano ${displayName} permite até ${maxSessions} sessão(ões) de WhatsApp.`;

      return res.status(403).json({ error: message });
    }

    // ===============================
    // 💾 CRIAR SESSÃO
    // ===============================
    await db.run(
      `INSERT INTO sessions (user_id, session_name, status)
       VALUES (?, ?, 'pending')`,
      [user.id, sessionName]
    );

    const result = await createWppSession(user.id, sessionName, {
      source: "manual_create",
    });

    io.to(`user:${user.id}`).emit("sessions:changed", { userId: user.id });

    return res.json({ session: result.sessionName });
  }
);



// Listar Sessões
app.get("/sessions/list", authMiddleware, async (req, res) => {
  const user = (req as any).user;

  const db = getDB();
  const sessions = await db.all(
    `SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC`,
    [user.id]
  );

  res.json({ sessions });
});


// Buscar QR
app.get("/sessions/qr/:userId/:sessionName", async (req, res) => {
  const { userId, sessionName } = req.params;
  const qrPath = getQRPathFor(`USER${userId}_${sessionName}`);

  if (!fs.existsSync(qrPath)) {
    return res.status(404).json({ error: "QR não gerado (ou já autenticado)" });
  }

  res.sendFile(qrPath);
});

// Apagar Sessão
app.delete("/sessions/delete", authMiddleware, async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName)
    return res.status(400).json({ error: "sessionName é obrigatório" });

  const user = (req as any).user;

  await deleteWppSession(user.id, sessionName);
  io.to(`user:${user.id}`).emit("sessions:changed", { userId: user.id });

  res.json({ ok: true });
});


// Reiniciar Sessão
app.post("/sessions/restart", async (req, res) => {
  const { token, sessionName } = req.body;
  if (requireFields(res, { token, sessionName })) return;

  const user = await findUserByToken(token);
  if (!user) return res.status(404).json({ error: "token inválido" });
  if (isSessionExpired(user)) {
    return res.status(401).json({ error: "Sessão expirada" });
  }

  const db = getDB();
  const session = await db.get<{ status: string }>(
    `SELECT status FROM sessions WHERE user_id = ? AND session_name = ? LIMIT 1`,
    [user.id, sessionName]
  );

  if (!session) {
    return res.status(404).json({ error: "Sessão não encontrada" });
  }

  if (session.status === "banned") {
    return res.status(409).json({
      error:
        "Esta sessão foi marcada com possível banimento. Aguarde e procure suporte antes de tentar autenticar novamente.",
    });
  }

  await deleteWppSession(user.id, sessionName);
  await createWppSession(user.id, sessionName, {
    source: "manual_restart",
  });

  io.to(`user:${user.id}`).emit("sessions:changed", { userId: user.id });
  res.json({ ok: true, message: "Sessão reiniciada com sucesso" });
});

// 🌙 Configurar horário de silêncio da IA
app.post("/user/ia-silence", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { start, end, enabled } = req.body;

    const db = getDB();

    if (!enabled) {
      // Desativar silêncio
      await db.run(
        `UPDATE users SET ia_silence_start = NULL, ia_silence_end = NULL WHERE id = ?`,
        [user.id]
      );
      return res.json({ ok: true, active: false });
    }

    // start e end são inteiros 0-23 (hora)
    const s = Number(start);
    const e = Number(end);

    if (isNaN(s) || isNaN(e) || s < 0 || s > 23 || e < 0 || e > 23) {
      return res.status(400).json({ ok: false, error: "Horas inválidas" });
    }

    await db.run(
      `UPDATE users SET ia_silence_start = ?, ia_silence_end = ? WHERE id = ?`,
      [s, e, user.id]
    );

    return res.json({ ok: true, active: true, start: s, end: e });
  } catch (err) {
    console.error("❌ Erro ao salvar silêncio da IA:", err);
    return res.status(500).json({ ok: false });
  }
});

// 🔁 Toggle IA Automática
app.post("/user/toggle-ia", authMiddleware, async (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled inválido" });
  }

  const user = (req as any).user; // 👈 vem do cookie

  const db = getDB();
  await db.run(
    `UPDATE users SET ia_enabled = ? WHERE id = ?`,
    [enabled ? 1 : 0, user.id]
  );

  res.json({ ok: true, ia_enabled: enabled ? 1 : 0 });
});

// 🎯 Trial status e onboarding
app.get("/api/trial/status", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const now = Date.now();
    const expiresAt = Number(user.plan_expires_at || 0);
    const startedAt = Number(user.trial_started_at || expiresAt - 7 * 24 * 60 * 60 * 1000);
    const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
    res.json({
      ok: true,
      onboardingDone: Number(user.trial_onboarding_done || 0) === 1,
      startedAt,
      expiresAt,
      daysLeft,
    });
  } catch (err) {
    console.error("Erro trial/status:", err);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/trial/onboarding-done", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    await getDB().run(
      `UPDATE users SET trial_onboarding_done = 1 WHERE id = ?`,
      [user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro trial/onboarding-done:", err);
    res.status(500).json({ ok: false });
  }
});


// =======================================
// ♻️ Restaurar sessões ao subir
// =======================================
export async function restoreSessionsOnStartup() {
  const db = getDB();

  const sessions = await db.all(
    `SELECT * FROM sessions WHERE status = 'connected'`
  );

  console.log(`🔄 Restaurando ${sessions.length} sessões conectadas...`);

  const concurrency = Math.max(1, Number(process.env.RESTORE_CONCURRENCY || 3));
  const executing = new Set<Promise<void>>();

  for (const s of sessions) {
    const task = (async () => {
      try {
        await createWppSession(s.user_id, s.session_name, {
          source: "startup_restore",
        });
      } catch (err) {
        console.warn(`⚠️ Falhou ao restaurar ${s.session_name}`, err);
      }
    })();

    executing.add(task);
    task.finally(() => executing.delete(task));

    if (executing.size >= concurrency) {
      await Promise.race(executing).catch(() => {});
    }
  }

  // aguardar tarefas restantes
  await Promise.allSettled(Array.from(executing));

  console.log("✅ Restauração concluída.");
}
// =======================================================
// ⏱️ WATCHDOG — EXPIRAÇÃO AUTOMÁTICA DO MODO HUMANO
// =======================================================
// ⚠️ ESSENCIAL: garante que o chat volte pro bot
// mesmo se o painel estiver fechado
// =======================================================

setInterval(() => {
  if (shuttingDown) return;
  const now = Date.now();

  for (const [key, last] of chatHumanLastActivity.entries()) {
    const isHuman = chatHumanLock.get(key) === true;

    if (!isHuman) {
      chatHumanLastActivity.delete(key);
      continue;
    }

    const lastActivity = Number(last || 0);
    const configured = chatHumanDuration.get(key);
    if (configured === null) continue; // sem limite por configuração

    const limitMs = configured ?? 5 * 60 * 1000;

    if (!lastActivity) {
      chatHumanLastActivity.set(key, now);
      continue;
    }

    if (now - lastActivity >= limitMs) {
      chatHumanLock.set(key, false);
      chatHumanLastActivity.delete(key);

      const parts = key.split("::");
      const chatId = parts[1];

      const fullKey = parts[0] || "";
      const userId = Number(fullKey.replace(/^USER/, "").split("_")[0]);
      io.to(`user:${userId}`).emit("human_state_changed", {
        chatId,
        state: false,
      });

      console.log("🤖 Modo humano desativado por inatividade:", chatId);
    }
  }
}, 5000);


async function gracefulShutdown(signal?: NodeJS.Signals | string) {
  if (shuttingDown) return;
  shuttingDown = true;
  appReady = false;
  console.log(`\n🛑 Recebido ${signal || "shutdown"} - finalizando com segurança...`);

  const tasks: Promise<any>[] = [];

  // Fecha novas conexões HTTP
  tasks.push(
    new Promise<void>((resolve) => {
      try {
        server.close((err) => {
          if (err) console.error("Erro ao fechar HTTP server:", err);
          resolve();
        });
      } catch (err) {
        console.error("Erro ao acionar close do HTTP server:", err);
        resolve();
      }
    })
  );

  // Fecha sockets
  tasks.push(
    new Promise<void>((resolve) => {
      try {
        io.close(() => resolve());
      } catch (err) {
        console.error("Erro ao fechar Socket.io:", err);
        resolve();
      }
    })
  );

  // Fecha sessões WPPConnect (sem apagar tokens)
  try {
    tasks.push(shutdownWppClients());
  } catch (err) {
    console.error("Erro ao fechar sessões WPP:", err);
  }

  // Fecha pool do MySQL
  try {
    tasks.push(closeDB());
  } catch (err) {
    console.error("Erro ao fechar pool do MySQL:", err);
  }

  // timeout de segurança
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, GRACEFUL_TIMEOUT_MS).unref()
  );

  await Promise.race([Promise.allSettled(tasks), timeout]);

  console.log("✅ Encerramento concluído. Saindo.");
  process.exit(0);
}

process.on("SIGTERM", (signal) => gracefulShutdown(signal));
process.on("SIGINT", (signal) => gracefulShutdown(signal));


// =======================================
// 🚀 Iniciar servidor
// =======================================
startTrialEmailCron();
// Limpeza diária de históricos de chat (randomiza start em até 1h para evitar pico)
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setTimeout(() => {
  if (shuttingDown) return;
  runChatHistoryCleanup();
  setInterval(() => {
    if (shuttingDown) return;
    runChatHistoryCleanup();
  }, CLEANUP_INTERVAL_MS);
}, Math.random() * 60 * 60 * 1000);

server.listen(3000, () => {
  console.log("🚀 Server online em http://localhost:3000");
});




// ===============================
// 🗺️ Fuso horário do usuário
// ===============================
app.post("/user/timezone", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const offset = Number(req.body?.timezoneOffset); // minutos em relação ao UTC
    if (!Number.isFinite(offset) || offset < -720 || offset > 840) {
      return res.status(400).json({ ok: false, error: "Fuso inválido" });
    }
    const db = getDB();
    await db.run("UPDATE users SET timezone_offset = ? WHERE id = ?", [offset, user.id]);
    return res.json({ ok: true, timezoneOffset: offset });
  } catch (err) {
    console.error("Erro ao salvar timezone:", err);
    return res.status(500).json({ ok: false, error: "Erro ao salvar fuso horário" });
  }
});
