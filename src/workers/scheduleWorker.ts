import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getDB, type DBClient } from "../database";
import { validatePhone } from "../utils/phoneUtils";
import { releaseMediaPayload } from "../utils/mediaUploader";
import { sendEmail } from "../utils/sendEmail";
import {
  SessionRateLimitError,
  assertSessionCanSend,
  getHumanDelay,
  recordSessionSend,
} from "../utils/humanDelay";
import { withTimeout } from "../utils/withTimeout";
import {
  DISPATCH_CONSECUTIVE_FAILURE_LIMIT,
  DISPATCH_ERROR_RATE_SAMPLE_SIZE,
  DISPATCH_ERROR_RATE_THRESHOLD,
  classifyDispatchError,
  evaluateDispatchCampaignRisk,
  evaluateDispatchPolicy,
  evaluateDispatchSessionHealth,
  recordDispatchContactEvent,
} from "../services/dispatchPolicy";
import {
  type NumberListValidationResult,
  validateNumberList,
} from "../services/listValidator";
import { ensureChat, getClient } from "../wppManager";

const WPP_TIMEOUT_MS = Number(process.env.WPP_TIMEOUT_MS || 12_000);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const SCHEDULE_FILES_ROOT = path.join(process.cwd(), "schedule_uploads");
const SCHEDULE_WORKER_BATCH_SIZE = Math.max(
  1,
  Number(process.env.SCHEDULE_WORKER_BATCH_SIZE || 5)
);
const SCHEDULE_WORKER_IDLE_MS = Math.max(
  1_000,
  Number(process.env.SCHEDULE_WORKER_IDLE_MS || 30_000)
);
const SCHEDULE_WORKER_MIN_DELAY_MS = Math.max(
  250,
  Number(process.env.SCHEDULE_WORKER_MIN_DELAY_MS || 1_000)
);
const SCHEDULE_WORKER_MAX_DELAY_MS = Math.max(
  SCHEDULE_WORKER_MIN_DELAY_MS,
  Number(process.env.SCHEDULE_WORKER_MAX_DELAY_MS || 30_000)
);
const SCHEDULE_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const SCHEDULE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const SCHEDULE_POLICY_RETRY_DELAY_MS = 60 * 60 * 1000;

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

type ConnectedSessionRow = {
  user_id: number;
  session_name: string;
};

type ScheduleNotificationUser = {
  name: string;
  email: string;
};

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
};

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

type ScheduleRow = {
  id: number;
  user_id: number;
  numbers: string;
  message: string;
  file: string | null;
  filename: string | null;
  preferred_session?: string | null;
  send_at: number;
  recurrence: "none" | "daily" | "weekly" | "monthly";
  recurrence_end: number | null;
  status: "pending" | "processing" | "sent" | "failed";
  processing_started_at: number | null;
};

type LiveListValidation = {
  sessionName: string | null;
  validation: NumberListValidationResult | null;
  warnings: string[];
};

type WorkerState = {
  running: boolean;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  lastWatchdogAt: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function loadConnectedSessionsByUser(
  db: DBClient,
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
  db: DBClient,
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

function buildSessionCandidates(
  preferred: string | null | undefined,
  connected: string[]
): string[] {
  const list = [...connected];
  const normPref = (preferred || "").trim();
  if (normPref && list.includes(normPref)) {
    return [normPref, ...list.filter((sessionName) => sessionName !== normPref)];
  }
  return list;
}

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

const normalizeVars = (input: any): Record<string, string> => {
  const out: Record<string, string> = {};
  const source = typeof input?.vars === "object" && input?.vars !== null ? input.vars : input;

  if (source && typeof source === "object") {
    Object.entries(source).forEach(([key, value]) => {
      if (["number", "message", "vars"].includes(key)) return;
      if (value === undefined || value === null) return;
      const strValue = typeof value === "string" ? value : String(value);
      const normalizedKey = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
      if (normalizedKey) out[normalizedKey] = strValue;
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

const buildContactsFromStored = (
  raw: any,
  baseMessage?: string
): PersonalizedContact[] => {
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
  const horaAgora = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });

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

  return template.replace(/{{\s*([\w.-]+)\s*}}/gi, (_match, rawKey) => {
    const key = String(rawKey || "").toLowerCase();
    return vars[key] !== undefined ? String(vars[key]) : "";
  });
};

const detectMimeFromBuffer = (buffer: Buffer): string | null => {
  if (buffer.length < 4) return null;

  const header4 = buffer.subarray(0, 4);
  if (header4[0] === 0xff && header4[1] === 0xd8 && header4[2] === 0xff) return "image/jpeg";
  if (header4.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (header4.equals(Buffer.from([0x47, 0x49, 0x46, 0x38]))) return "image/gif";
  if (header4.equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return "application/pdf";

  if (header4.equals(Buffer.from([0x52, 0x49, 0x46, 0x46]))) {
    const subtype = buffer.subarray(8, 12).toString("ascii");
    if (subtype === "WEBP") return "image/webp";
    if (subtype === "WAVE") return "audio/wav";
  }

  if (
    buffer.subarray(0, 3).toString("ascii") === "ID3" ||
    (header4[0] === 0xff && (header4[1] & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }

  if (buffer.subarray(0, 4).equals(Buffer.from([0x4f, 0x67, 0x67, 0x53]))) return "audio/ogg";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return "video/mp4";
  }
  if (header4[0] === 0x50 && header4[1] === 0x4b) return "application/zip";

  return null;
};

const isDataUrl = (value: unknown): value is string =>
  typeof value === "string" && /^data:[^;]+;base64,/.test(String(value));

const sanitizeScheduleFilename = (name: string) => {
  const base = path.basename(name || "arquivo");
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_");
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

const loadScheduleFileFromPath = (
  storedPath: string,
  filename?: string
): PreparedMediaFile | null => {
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

const sanitizeIncomingFile = (input: {
  dataUrl?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
}): SanitizedFile => {
  const candidate =
    input.dataUrl ??
    (input.mimetype && input.base64
      ? `data:${input.mimetype};base64,${input.base64}`
      : "");

  const match =
    typeof candidate === "string"
      ? candidate.match(/^data:([^;]+);base64,(.+)$/i)
      : null;

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
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new Error("Arquivo excede limite de 15MB");
  }

  const detectedMime = detectMimeFromBuffer(buffer);
  const finalMime = detectedMime ?? declaredMime;

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

const ensureScheduleFileOnDisk = async (
  db: DBClient,
  row: ScheduleRow
): Promise<{ file: PreparedMediaFile | null; storedPath: string | null }> => {
  if (!row.file) return { file: null, storedPath: null };

  const safeFilename = row.filename || "arquivo";
  if (isDataUrl(row.file)) {
    try {
      const safe = sanitizeIncomingFile({ dataUrl: row.file, filename: safeFilename });
      const storedPath = persistScheduleFile(row.user_id, safe);
      await db.run(`UPDATE schedules SET file = ?, filename = ? WHERE id = ?`, [
        storedPath,
        safe.filename,
        row.id,
      ]);
      releaseMediaPayload(safe);
      return {
        file: {
          content: resolveSchedulePath(storedPath),
          filename: safe.filename,
        },
        storedPath,
      };
    } catch (err) {
      console.error("⚠️ Falha ao migrar arquivo de agendamento:", err);
      return { file: null, storedPath: null };
    }
  }

  const loaded = loadScheduleFileFromPath(row.file, row.filename || undefined);
  return { file: loaded, storedPath: row.file };
};

function calculateNextSendAt(
  current: number,
  recurrence: string,
  recurrenceEnd?: number | null
): number | null {
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
  if (nextTs <= now) return calculateNextSendAt(nextTs, recurrence, recurrenceEnd);

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
  if (!logId || !itemLogs.length) return;

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
      (await db.get<ScheduleNotificationUser>(
        `SELECT name, email FROM users WHERE id = ?`,
        [row.user_id]
      ));

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

    await sendEmail(
      user.email,
      `Agendamento #${row.id} bloqueado por mídia indisponível`,
      html
    );
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

async function claimDueSchedules(limit: number): Promise<ScheduleRow[]> {
  const safeLimit = Math.max(1, Math.trunc(limit || 1));
  const db = getDB();
  const now = Date.now();
  // Usa um token único por claim para reler exatamente o lote desta instância
  // sem depender de SKIP LOCKED, que não está disponível em algumas versões do MariaDB.
  const claimedAt = now * 1000 + Math.floor(Math.random() * 1000);

  const claimResult = await db.run(
    `UPDATE schedules
     SET status = 'processing', processing_started_at = ?
     WHERE status = 'pending' AND send_at <= ?
     ORDER BY send_at ASC, id ASC
     LIMIT ${safeLimit}`,
    [claimedAt, now]
  );

  if (!claimResult.affectedRows) return [];

  return db.all<ScheduleRow>(
    `SELECT *
     FROM schedules
     WHERE status = 'processing' AND processing_started_at = ?
     ORDER BY send_at ASC, id ASC`,
    [claimedAt]
  );
}

async function releaseStuckSchedules() {
  const db = getDB();
  const timeoutThreshold = Date.now() - SCHEDULE_PROCESSING_TIMEOUT_MS;
  const reset = await db.run(
    `UPDATE schedules
     SET status = 'pending', processing_started_at = NULL
     WHERE status = 'processing'
       AND (processing_started_at IS NULL OR processing_started_at <= ?)`,
    [timeoutThreshold]
  );

  if (reset.affectedRows) {
    console.warn(
      `🔁 Watchdog: ${reset.affectedRows} agendamento(s) reaberto(s) para pending`
    );
  }
}

async function resolveNextCycleDelay() {
  const db = getDB();
  const next = await db.get<{ send_at: number }>(
    `SELECT send_at
     FROM schedules
     WHERE status = 'pending'
     ORDER BY send_at ASC, id ASC
     LIMIT 1`
  );

  if (!next?.send_at) return SCHEDULE_WORKER_IDLE_MS;

  const diff = Number(next.send_at) - Date.now();
  return Math.min(
    SCHEDULE_WORKER_MAX_DELAY_MS,
    Math.max(SCHEDULE_WORKER_MIN_DELAY_MS, diff)
  );
}

async function processSingleSchedule(
  db: DBClient,
  row: ScheduleRow,
  connectedSessionsByUser: Map<number, string[]>,
  notificationUsersById: Map<number, ScheduleNotificationUser>
) {
  const rawNumbers = JSON.parse(row.numbers || "[]");
  const contactsList = buildContactsFromStored(rawNumbers, row.message);
  const userId = row.user_id;
  const notificationUser = notificationUsersById.get(userId) || null;
  let successCount = 0;
  let failureCount = 0;
  let itemLogs: ScheduleItemLog[] = [];
  const preferredSession = row.preferred_session || null;
  const campaignRef = `schedule:${row.id}:${row.processing_started_at || Date.now()}`;

  const connectedSessions = connectedSessionsByUser.get(userId) || [];
  if (!connectedSessions.length) {
    console.warn("⚠️ Nenhuma sessão conectada para user:", userId);
    await requeueScheduleForLater(
      db,
      row.id,
      SCHEDULE_POLICY_RETRY_DELAY_MS,
      "Nenhuma sessão conectada disponível para este agendamento."
    );
    return;
  }

  const sessionCandidates = buildSessionCandidates(preferredSession, connectedSessions);

  let safeRowFile: PreparedMediaFile | null = null;
  let storedFilePath: string | null = null;
  if (row.file) {
    const ensured = await ensureScheduleFileOnDisk(db, row);
    safeRowFile = ensured.file;
    storedFilePath = ensured.storedPath;
  }

  if (row.file && !safeRowFile) {
    const failureReason =
      "A mídia anexada a este agendamento não está mais disponível no storage configurado. Reenvie o arquivo antes de tentar novamente.";
    console.error(`❌ Agendamento ${row.id} bloqueado: ${failureReason}`);
    await failScheduleDueToMissingMedia(
      db,
      row,
      contactsList,
      failureReason,
      notificationUser
    );
    return;
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
    return;
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
      row,
      0,
      itemLogs.length + failedLogs.length,
      [...itemLogs, ...failedLogs],
      processedAt
    );
    console.warn(
      `⚠️ Agendamento ${row.id} bloqueado por baixa qualidade da lista: ${failureReason}`
    );
    return;
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

        const target = await ensureChat(client, contact.number);
        const finalMessage = renderTemplate(contact.message ?? row.message ?? "", contact);

        if (safeRowFile) {
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
          await withTimeout(
            client.sendText(target, finalMessage),
            WPP_TIMEOUT_MS,
            "sendText"
          );
        } else {
          throw new Error("Mensagem vazia e mídia inválida");
        }

        sessionUsed = sessionUsed || shortName;
        successCount += 1;
        consecutiveFailures = 0;
        nextContactIndex = contactIndex + 1;
        itemLogs.push({
          number: contact.number,
          status: "sent",
          sentAt: Date.now(),
        });

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

    if (campaignPauseReason) break;
    if (nextContactIndex >= contactsToSend.length) break;
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
    return;
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
    console.warn(
      "⚠️ Nenhuma sessão conseguiu enviar o agendamento:",
      row.id,
      sessionCandidates
    );
    await requeueScheduleForLater(
      db,
      row.id,
      SCHEDULE_POLICY_RETRY_DELAY_MS,
      String(lastSendError || "Nenhuma sessão conseguiu concluir o envio do agendamento.")
    );
    return;
  }

  await db.run(
    `UPDATE schedules SET status = 'sent', processing_started_at = NULL WHERE id = ?`,
    [row.id]
  );

  const recurrence = row.recurrence || "none";
  const recurrenceEnd = row.recurrence_end || null;
  const nextSendAt = calculateNextSendAt(row.send_at, recurrence, recurrenceEnd);
  const sentAt = Date.now();

  await insertScheduleExecutionLog(
    db,
    row,
    successCount,
    failureCount,
    itemLogs,
    sentAt
  );

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
      [
        userId,
        row.numbers,
        row.message,
        nextFilePath,
        nextFilename,
        preferredSession ?? null,
        nextSendAt,
        recurrence,
        recurrenceEnd,
      ]
    );
  }

  if (scheduleWarnings.length) {
    console.warn("⚠️ Alertas de política no agendamento:", row.id, scheduleWarnings);
  }
  console.log("✅ Agendamento enviado:", row.id);
}

async function processClaimedSchedules(rows: ScheduleRow[]) {
  if (!rows.length) return;

  const db = getDB();
  const schedulerUserIds = Array.from(
    new Set(rows.map((row) => row.user_id).filter((id) => Number.isFinite(id)))
  );
  const connectedSessionsByUser = await loadConnectedSessionsByUser(db, schedulerUserIds);
  const notificationUsersById = await loadScheduleNotificationUsers(db, schedulerUserIds);

  for (const row of rows) {
    try {
      await processSingleSchedule(
        db,
        row,
        connectedSessionsByUser,
        notificationUsersById
      );
    } catch (err) {
      console.error("❌ Erro geral no agendador:", err);
      try {
        await db.run(
          `UPDATE schedules
           SET status = 'pending', processing_started_at = NULL
           WHERE id = ? AND status = 'processing'`,
          [row.id]
        );
      } catch {
        // ignore secondary failure to preserve original error log
      }
    }
  }
}

let sharedWorkerState: WorkerState | null = null;

function attachShutdownHooks(state: WorkerState) {
  const stop = () => {
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export function startScheduleWorker() {
  if (sharedWorkerState) return;

  const state: WorkerState = {
    running: false,
    stopped: false,
    timer: null,
    lastWatchdogAt: 0,
  };

  sharedWorkerState = state;
  attachShutdownHooks(state);

  const scheduleNext = (delayMs: number) => {
    if (state.stopped) return;
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      void runCycle();
    }, Math.max(0, delayMs));
    state.timer.unref?.();
  };

  const runCycle = async () => {
    if (state.stopped || state.running) return;
    state.running = true;

    let claimedRows: ScheduleRow[] = [];
    try {
      const now = Date.now();
      if (now - state.lastWatchdogAt >= SCHEDULE_WATCHDOG_INTERVAL_MS) {
        await releaseStuckSchedules();
        state.lastWatchdogAt = now;
      }

      claimedRows = await claimDueSchedules(SCHEDULE_WORKER_BATCH_SIZE);
      await processClaimedSchedules(claimedRows);
    } catch (err) {
      console.error("❌ Erro crítico no worker de agendamentos:", err);
    } finally {
      state.running = false;

      if (state.stopped) return;

      const nextDelay = claimedRows.length
        ? 0
        : await resolveNextCycleDelay().catch((err) => {
            console.error("❌ Erro ao calcular próximo ciclo do agendador:", err);
            return SCHEDULE_WORKER_IDLE_MS;
          });

      scheduleNext(nextDelay);
    }
  };

  console.log(
    `⏱️ Worker de agendamentos ativo (batch=${SCHEDULE_WORKER_BATCH_SIZE}, idle=${SCHEDULE_WORKER_IDLE_MS}ms)`
  );
  scheduleNext(0);
}
