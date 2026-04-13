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
import { csrfMiddleware } from "./middlewares/csrf";

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
import { availableTrialKeys, getTrialTemplate, saveTrialTemplate, listTrialTemplates } from "./services/trialTemplates";

import { sendVerifyEmail } from "./utils/sendVerifyEmail";
import { validatePhone } from "./utils/phoneUtils";
import { withTimeout } from "./utils/withTimeout";
import { runChatHistoryCleanup } from "./services/chatHistoryCleaner";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DISPARO_MIN_INTERVAL_MS = Number(process.env.DISPARO_MIN_INTERVAL_MS || 1500);
const disparoRateLimit = new Map<number, number>();
const MAX_CHAT_MESSAGES = Number(process.env.MAX_CHAT_MESSAGES || 500);
const TRIAL_EMAIL_SWEEP_MS = 60 * 60 * 1000; // 1h
const WPP_TIMEOUT_MS = Number(process.env.WPP_TIMEOUT_MS || 12_000);

import { getDB } from "./database";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
  send_at: number;
  recurrence: "none" | "daily" | "weekly" | "monthly";
  recurrence_end: number | null;
  status: "pending" | "processing" | "sent";
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
} from "./wppManager";
import { simulateFlowRun, simulateWelcomeFlow } from "./wppManager";


import { User } from "./database/types";


const app = express();

// ===============================
// 🧩 Utilitário de template simples para mensagens
// ===============================
type PersonalizedContact = {
  number: string;
  message?: string;
  vars?: Record<string, string>;
};

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
        await sendTrialEmail(user, tpl.subject, tpl.body, "trial_email_day1_sent");
        continue;
      }

      // Dia 3
      if (daysElapsed >= 3 && !user.trial_email_day3_sent) {
        const tpl = await getTrialTemplate("trial_day3");
        await sendTrialEmail(user, tpl.subject, tpl.body, "trial_email_day3_sent");
        continue;
      }

      // Dia 6
      if (daysElapsed >= 6 && !user.trial_email_day6_sent) {
        const tpl = await getTrialTemplate("trial_day6");
        await sendTrialEmail(user, tpl.subject, tpl.body, "trial_email_day6_sent");
        continue;
      }

      // Último dia (<=1 dia restante)
  if (daysLeft <= 1 && !user.trial_email_last_sent) {
        const tpl = await getTrialTemplate("trial_last");
        const html = tpl.body.replace(/{{BASE_URL}}/g, BASE_URL);
        await sendTrialEmail(user, tpl.subject, html, "trial_email_last_sent");
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
const SCHEDULE_FILES_ROOT = path.join(process.cwd(), "schedule_uploads");

const isDataUrl = (val: unknown): val is string => typeof val === "string" && /^data:[^;]+;base64,/.test(String(val));

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

const loadScheduleFileFromPath = (storedPath: string, filename?: string): SanitizedFile | null => {
  try {
    const abs = resolveSchedulePath(storedPath);
    const buffer = fs.readFileSync(abs);
    const detected = detectMimeFromBuffer(buffer);
    const guessed = guessMimeFromFilename(filename || path.basename(abs));
    const mime = detected || guessed || "application/octet-stream";
    const base64 = buffer.toString("base64");

    return {
      dataUrl: `data:${mime};base64,${base64}`,
      base64,
      buffer,
      mime,
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
): Promise<{ file: SanitizedFile | null; storedPath: string | null }> => {
  if (!row.file || !row.filename) return { file: null, storedPath: null };

  // Migração automática de registros antigos em base64
  if (isDataUrl(row.file)) {
    try {
      const safe = sanitizeIncomingFile({ dataUrl: row.file, filename: row.filename });
      const storedPath = persistScheduleFile(row.user_id, safe);
      await db.run(`UPDATE schedules SET file = ? WHERE id = ?`, [storedPath, row.id]);
      return { file: safe, storedPath };
    } catch (err) {
      console.error("⚠️ Falha ao migrar arquivo de agendamento:", err);
      return { file: null, storedPath: null };
    }
  }

  const loaded = loadScheduleFileFromPath(row.file, row.filename);
  return { file: loaded, storedPath: row.file };
};

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
    allowedHeaders: ["Content-Type", "Authorization", "x-csrf-token"],
  })
);
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
app.use(csrfMiddleware);
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
    const user = (req as any).user as User;
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

  io.on("connection", (socket) => {
    console.log("🔌 Socket conectado:", socket.id);
    const uid = socket.handshake.auth?.userId;
    if (uid) socket.join(`user:${uid}`);
    socket.on("crm:changed_local", () => {
      if (!uid) return;
      io.to(`user:${uid}`).emit("crm:changed", { type: "sync" });
    });
    socket.on("chat_ai_state_request", async (chatId) => {
      const userId = socket.handshake.auth?.userId;
      if (!userId || !chatId) return;

    const state = await getChatAI(userId, chatId);
    socket.emit("chat_ai_state", { chatId, state });
  });


  socket.on("chat_ai_off", async (chatId) => {
    const userId = socket.handshake.auth?.userId;
    if (!userId) return;

    await setChatAI(userId, chatId, false);

    const key = `USER${userId}_${chatId}`;
    chatAILock.set(key, false);

    io.emit("chat_ai_state", { chatId, state: false });
  });


  socket.on("chat_ai_on", async (chatId) => {
    const userId = socket.handshake.auth?.userId;
    if (!userId) return;

    await setChatAI(userId, chatId, true);

    const key = `USER${userId}_${chatId}`;
    chatAILock.set(key, true);

    io.emit("chat_ai_state", { chatId, state: true });
  });

  socket.on("admin_send_message", async ({ chatId, body, file, filename, mimetype }) => {
    try {
      const userId = socket.handshake.auth?.userId;
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
    const userId = socket.handshake.auth?.userId;
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

    } else {
      const humanKey = `${fullKey}::${chatId}`;

      chatHumanLock.set(humanKey, false);
      chatHumanLastActivity.delete(humanKey);

      cancelAIDebounce(chatKey);

      io.emit("human_state_changed", {
        chatId,
        userId,
        sessionName,
        state: false,
      });

      // 📄 Resumo automático da conversa salvo como nota no CRM
      summarizeConversationToCrm({
        userId: Number(userId),
        sessionName,
        chatId,
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
      const userId = socket.handshake.auth?.userId;
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
      const userId = socket.handshake.auth?.userId;
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
      const userId = socket.handshake.auth?.userId;
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

    const db = getDB();
    const user = await db.get<any>("SELECT * FROM users WHERE token = ?", [token]);

    if (!user) {
      if (isHtml) return res.redirect("/login");
      return res.status(401).json({ error: "Token inválido", redirect: "/login" });
    }

    // ✅ SALVA O USER SEMPRE
    (req as any).user = user;

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

    const emailVerified = Number(user.email_verified) === 1;

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

  res.render("checkout", {
    user
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

app.get("/auth/me", authMiddleware, (req, res) => {
  res.json({ user: (req as any).user });
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

    const rows = await db.all(
      `SELECT * FROM crm WHERE user_id = ? ORDER BY id DESC`,
      [user.id]
    );

    const clients = rows.map((r: any) => ({
      ...r,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : [],
      notes: typeof r.notes === "string" ? JSON.parse(r.notes) : [],
    }));

    res.json({ ok: true, clients }); // ✅
  } catch (err) {
    console.error("❌ Erro ao listar CRM:", err);
    res.json({ ok: false, clients: [] });
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
      const buffer = Buffer.from(String(fileBase64), "base64");
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
const genToken = () => crypto.randomBytes(20).toString("hex");

async function findUserByToken(token: string): Promise<User | null> {
  const db = getDB();
  return db.get<User>(`SELECT * FROM users WHERE token = ?`, [token]);
}

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

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

  res.cookie("token", user.token, {
    httpOnly: true,
    sameSite: "strict",
    secure: isProd,
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 dias
  });
  res.json({ ok: true });
});

app.get("/disparo", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("disparo", { user });
});
app.get("/agendamentos", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("agendamentos", { user });
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
      SELECT id, token, email_verify_expires
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

    // 🔥 AGORA O TOKEN EXISTE CORRETAMENTE
    res.cookie("token", user.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });

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

app.post("/auth/forgot-password", async (req, res) => {
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

app.post("/auth/resend-verify-email", authMiddleware, async (req, res) => {
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
  "/api/disparo",
  authMiddleware,
  subscriptionGuard,
  async (req: Request, res: Response) => {

    const { number, message, file, filename, contacts } = req.body;
    const user = (req as any).user as User;

    // rate limit mínimo
    const now = Date.now();
    const last = disparoRateLimit.get(user.id) || 0;
    const delta = now - last;
    if (delta < DISPARO_MIN_INTERVAL_MS) {
      const waitMs = DISPARO_MIN_INTERVAL_MS - delta;
      return res.status(429).json({ error: `Aguarde ${Math.ceil(waitMs / 1000)}s para novo disparo` });
    }
    disparoRateLimit.set(user.id, now);

    const contactsArr: any[] = Array.isArray(contacts) ? contacts : [];
    const hasPersonalized = contactsArr.length > 0;

    if (!number && !hasPersonalized) {
      return res.status(400).json({ error: "Número é obrigatório" });
    }

    const contactList: PersonalizedContact[] = hasPersonalized
      ? buildContactsFromPayload(contactsArr)
      : (() => {
          const { ok, sanitized } = validatePhone(number);
          if (!ok) return [];
          return [{ number: sanitized, message }];
        })();

    if (!contactList.length) {
      return res.status(400).json({ error: "Nenhum número válido" });
    }

    const hasTextMessage = contactList.some((c) => (c.message ?? message ?? "").trim().length > 0);
    if (!file && !hasTextMessage) {
      return res.status(400).json({
        error: "Mensagem ou imagem é obrigatória"
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

    try {
      const db = getDB();

      // 🔎 Buscar sessão conectada
      const session = await db.get(
        `SELECT session_name
         FROM sessions
         WHERE user_id = ? AND status = 'connected'
         LIMIT 1`,
        [user.id]
      );

      if (!session) {
        return res.status(400).json({
          error: "Nenhuma sessão ativa para este usuário"
        });
      }

      const full = `USER${user.id}_${session.session_name}`;
      const client = getClient(full);

      if (!client) {
        return res.status(400).json({
          error: "Sessão não encontrada ou desconectada"
        });
      }

      for (const contact of contactList) {
        const chatId = `${contact.number}@c.us`;
        const finalMessage = renderTemplate(contact.message ?? message ?? "", contact);

        if (!safeFile) {
          await withTimeout(client.sendText(chatId, finalMessage), WPP_TIMEOUT_MS, "sendText");
          continue;
        }

        await withTimeout(
          client.sendFile(
            chatId,
            safeFile.dataUrl,
            safeFile.filename || filename || "arquivo",
            finalMessage // legenda opcional
          ),
          WPP_TIMEOUT_MS,
          "sendFile"
        );
      }

      return res.json({ ok: true });

    } catch (err) {
      console.error("⚠️ Erro no disparo:", err);
      return res.status(500).json({
        error: "Erro ao enviar mensagem"
      });
    }
  }
);

// ===============================
// 📅 API — AGENDAMENTOS
// ===============================

// Criar agendamento
app.post("/api/agendamentos/create", authMiddleware, subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const { numbers, contacts, message, file, filename, sendAt, recurrenceEnd } = req.body;
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

  const planLimits: Record<string, number> = {
    free: 50,
    trial: 50,
    starter: 50,
    pro: 200,
  };
  const plan = String(user.plan || "").toLowerCase();
  const maxNumbers = planLimits[plan] ?? 50;
  const totalCount = hasPersonalized ? contactsArr.length : numbersArr.length;
  if (totalCount > maxNumbers) {
    return res.status(400).json({
      error: `Limite de ${maxNumbers} números para seu plano (${plan || "starter"}). Reduza a lista.`,
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
    } catch (err: any) {
      console.error("⚠️ Erro ao salvar arquivo do agendamento:", err);
      return res.status(500).json({ error: "Falha ao salvar arquivo" });
    }
  }

  // Checar duplicado: mesmo user, mesma data, mesma lista
  const db = getDB();
  const existingDup = await db.get<{ id: number }>(
    `SELECT id FROM schedules
     WHERE user_id = ? AND status = 'pending' AND send_at = ? AND numbers = ?
     LIMIT 1`,
    [user.id, sendAtMs, JSON.stringify(normalized)]
  );
  if (existingDup && req.body?.forceDuplicate !== true) {
    return res.status(409).json({
      duplicate: true,
      existingId: existingDup.id,
      message: "Já existe um agendamento igual (mesmos números e data)."
    });
  }

  await db.run(
    `INSERT INTO schedules (user_id, numbers, message, file, filename, send_at, recurrence, recurrence_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, JSON.stringify(normalized), message, storedFilePath, storedFilename, sendAtMs, recurrence, recurrenceEndMs]
  );

  res.json({ ok: true });
});

// Editar agendamento pendente
app.put("/api/agendamentos/update/:id", authMiddleware, subscriptionGuard, async (req, res) => {
  const user = (req as any).user;
  const id = Number(req.params.id);
  const { numbers, contacts, message, file, filename, sendAt, keepExistingFile, recurrence, recurrenceEnd } = req.body || {};

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

  const planLimits: Record<string, number> = {
    free: 50,
    trial: 50,
    starter: 50,
    pro: 200,
  };
  const plan = String(user.plan || "").toLowerCase();
  const maxNumbers = planLimits[plan] ?? 50;
  const totalCount = hasPersonalized ? contactsArr.length : numbersArr.length;
  if (totalCount > maxNumbers) {
    return res.status(400).json({
      error: `Limite de ${maxNumbers} números para seu plano (${plan || "starter"}). Reduza a lista.`,
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

  const recurrenceRaw = (recurrence || existing.recurrence || "none") as string;
  const allowed = ["none", "daily", "weekly", "monthly"];
  const finalRecurrence = allowed.includes(recurrenceRaw) ? recurrenceRaw : "none";
  const finalRecurrenceEnd = recurrenceEndMs ?? existing.recurrence_end ?? null;

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
    [user.id, sendAtMs, JSON.stringify(normalized), id]
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
      await deleteScheduleFileIfUnused(db, existingRow.file);
    } catch (err: any) {
      console.error("⚠️ Erro ao salvar arquivo do agendamento:", err);
      return res.status(500).json({ error: "Falha ao salvar arquivo" });
    }
  } else if (keepExistingFile) {
    const ensured = await ensureScheduleFileOnDisk(db, existingRow);
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

  await db.run(
    `UPDATE schedules
     SET numbers = ?, message = ?, file = ?, filename = ?, send_at = ?, recurrence = ?, recurrence_end = ?
     WHERE id = ? AND user_id = ?`,
    [
      JSON.stringify(normalized),
      message,
      finalFilePath,
      finalFilename,
      sendAtMs,
      finalRecurrence,
      finalRecurrenceEnd,
      id,
      user.id,
    ]
  );

  return res.json({ ok: true });
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

// ===============================
// ⏱️ AGENDADOR — VERSÃO FINAL, ESTÁVEL E SEM "No LID for user"
// ===============================
const SCHEDULE_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const SCHEDULE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos

let schedulerRunning = false;
setInterval(async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const db = getDB();
    const now = Date.now();

    const schedules = await db.all(
      `SELECT * FROM schedules
       WHERE status = 'pending' AND send_at <= ?`,
      [now]
    );

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

        const rawNumbers = JSON.parse(row.numbers || "[]");
        const contactsList: PersonalizedContact[] = buildContactsFromStored(rawNumbers, row.message);
        const userId = row.user_id;
        let successCount = 0;
        let failureCount = 0;
        const itemLogs: { number: string; status: "sent" | "error"; error?: string; sentAt: number }[] = [];

        // 🔎 Buscar UMA sessão conectada
        const sessions = await db.all(
          `SELECT session_name
           FROM sessions
           WHERE user_id = ? AND status = 'connected'
           LIMIT 1`,
          [userId]
        );

        if (!sessions.length) {
          console.warn("⚠️ Nenhuma sessão conectada para user:", userId);
          continue;
        }

        const full = `USER${userId}_${sessions[0].session_name}`;
        const client = getClient(full);

        if (!client) {
          console.warn("⚠️ Client não encontrado:", full);
          continue;
        }

        let safeRowFile: SanitizedFile | null = null;
        let storedFilePath: string | null = null;
        if (row.file && row.filename) {
          const ensured = await ensureScheduleFileOnDisk(db, row as ScheduleRow);
          safeRowFile = ensured.file;
          storedFilePath = ensured.storedPath;
        }

        // =========================
        // 📤 ENVIO DAS MENSAGENS
        // =========================
        for (const contact of contactsList) {
          try {
            // ✅ valida número (SEM @c.us)
            const target = await ensureChat(client, contact.number);
            const finalMessage = renderTemplate(contact.message ?? row.message ?? "", contact);

            if (safeRowFile) {
              // 📎 MÍDIA
              await withTimeout(
                client.sendFile(
                  target,
                  safeRowFile.dataUrl,
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
            successCount += 1;
            itemLogs.push({ number: contact.number, status: "sent", sentAt: Date.now() });

            // ⏳ delay anti-ban
            await new Promise(r => setTimeout(r, 1200));

          } catch (err: any) {
            console.error(
              "⚠️ Erro envio agendado (número):",
              contact.number,
              err?.message || err
            );
            failureCount += 1;
            itemLogs.push({ number: contact.number, status: "error", error: String(err?.message || err), sentAt: Date.now() });
          }
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
        const logInsert = await db.run(
          `INSERT INTO schedule_logs (schedule_id, user_id, success_count, failure_count, sent_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [row.id, userId, successCount, failureCount, sentAt, sentAt]
        );
        const logId = (logInsert as any)?.insertId;
        if (logId) {
          for (const item of itemLogs) {
            await db.run(
              `INSERT INTO schedule_log_items (log_id, schedule_id, user_id, number, status, error, sent_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [logId, row.id, userId, item.number, item.status, item.error || null, item.sentAt]
            );
          }
        }

        // 📧 Notificação por e-mail (best-effort)
        try {
          const user = await db.get<{ name: string; email: string }>(
            `SELECT name, email FROM users WHERE id = ?`,
            [userId]
          );

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
            `INSERT INTO schedules (user_id, numbers, message, file, filename, send_at, recurrence, recurrence_end)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, row.numbers, row.message, nextFilePath, nextFilename, nextSendAt, recurrence, recurrenceEnd]
          );
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
  } catch (err) {
    console.error("❌ Erro crítico no loop do agendador:", err);
  } finally {
    schedulerRunning = false;
  }
}, 10000);

// 🛡️ Watchdog para destravar agendamentos travados em "processing"
setInterval(async () => {
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
  } catch (err) {
    console.error("❌ Erro no watchdog de agendamentos:", err);
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
      fallbackMessage: String(req.body?.fallbackMessage ?? current.fallbackMessage),
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

app.post("/register", async (req, res) => {
  const { name, email, password, prompt } = req.body;
  if (requireFields(res, { name, email, password })) return;

  const db = getDB();

  const exists = await db.get(
    "SELECT id FROM users WHERE email = ?",
    [email]
  );

  if (exists) {
    return res.json({ error: "Email já cadastrado" });
  }

  const hash = await bcrypt.hash(password, 10);
  const token = genToken();

  const trialDays = 7;
  const now = Date.now();

  // 🔥 cria usuário
  await db.run(
    `INSERT INTO users (
      name, email, password, prompt, token,
      plan, subscription_status, plan_expires_at, trial_started_at,
      email_verified, email_verify_token, email_verify_expires
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      hash,
      prompt || "",
      token,
      "free",
      "trial",
      now + trialDays * 24 * 60 * 60 * 1000,
      now,

      0, // email_verified
      null,
      null
    ]
  );

  // 🔥 buscar o usuário recém criado (pra pegar id)
  const newUser = await db.get<any>(
    `SELECT id FROM users WHERE email = ?`,
    [email]
  );

  if (!newUser) {
    return res.status(500).json({ error: "Erro ao criar usuário" });
  }

  // 🔥 enviar email com token + salvar no banco
  try {
    await sendVerifyEmail(newUser.id);
  } catch (err) {
    console.error("❌ Erro ao enviar email:", err);
  }

  return res.json({
    ok: true,
    message: "Cadastro realizado! Verifique seu e-mail para ativar a conta."
  });
});

// Login
app.post("/auth/login", async (req, res) => {
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
  const newToken = genToken();
  await getDB().run(`UPDATE users SET token = ? WHERE id = ?`, [newToken, user.id]);

  // ✅ SEMPRE cria o cookie quando login estiver correto
  res.cookie("token", newToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // Railway => true
    path: "/",
  });

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
    const db = getDB();
    const rotated = genToken();
    // invalida imediatamente o token atual
    await db.run(`UPDATE users SET token = ? WHERE id = ?`, [rotated, user.id]);
  } catch (err) {
    console.error("Erro ao rotacionar token no logout:", err);
    // continua para limpar cookie mesmo assim
  }

  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/", // 🔥 OBRIGATÓRIO
  });

  return res.json({ ok: true });
});

// =======================================
// 🔄 Rotacionar token manualmente (logout global)
// =======================================
app.post("/auth/rotate-token", authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const db = getDB();
    const newToken = genToken();

    await db.run(`UPDATE users SET token = ? WHERE id = ?`, [newToken, user.id]);

    res.cookie("token", newToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });

    // retorna para uso em integrações se o cliente quiser
    return res.json({ ok: true, token: newToken });
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

    const maxSessions =
      user.plan === "free" ? 1 :
        user.plan === "starter" ? 1 :
          user.plan === "pro" ? 3 :
            0;


    if (totalSessions >= maxSessions) {
      let message = "Limite de sessões atingido.";

      if (user.plan === "free") {
        message = "O plano Free permite apenas 1 sessão de WhatsApp. Faça upgrade para liberar mais.";
      }
      else if (user.plan === "starter") {
        message = "O plano Starter permite apenas 1 sessão de WhatsApp.";
      }
      else if (user.plan === "pro") {
        message = "O plano Pro permite até 3 sessões de WhatsApp.";
      }

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

    const result = await createWppSession(user.id, sessionName);

    io.emit("sessions:changed", { userId: user.id });

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
  io.emit("sessions:changed", { userId: user.id });

  res.json({ ok: true });
});


// Reiniciar Sessão
app.post("/sessions/restart", async (req, res) => {
  const { token, sessionName } = req.body;
  if (requireFields(res, { token, sessionName })) return;

  const user = await findUserByToken(token);
  if (!user) return res.status(404).json({ error: "token inválido" });

  await deleteWppSession(user.id, sessionName);
  await createWppSession(user.id, sessionName);

  io.emit("sessions:changed", { userId: user.id });
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

  for (const s of sessions) {
    try {
      await createWppSession(s.user_id, s.session_name);
    } catch {
      console.warn(`⚠️ Falhou ao restaurar ${s.session_name}`);
    }
  }

  console.log("✅ Restauração concluída.");
}
// =======================================================
// ⏱️ WATCHDOG — EXPIRAÇÃO AUTOMÁTICA DO MODO HUMANO
// =======================================================
// ⚠️ ESSENCIAL: garante que o chat volte pro bot
// mesmo se o painel estiver fechado
// =======================================================

setInterval(() => {
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

      io.emit("human_state_changed", {
        chatId,
        state: false,
      });

      console.log("🤖 Modo humano desativado por inatividade:", chatId);
    }
  }
}, 5000);



// =======================================
// 🚀 Iniciar servidor
// =======================================
startTrialEmailCron();
// Limpeza diária de históricos de chat (randomiza start em até 1h para evitar pico)
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
setTimeout(() => {
  runChatHistoryCleanup();
  setInterval(runChatHistoryCleanup, CLEANUP_INTERVAL_MS);
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
