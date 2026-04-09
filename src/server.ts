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

import { sendVerifyEmail } from "./utils/sendVerifyEmail";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DISPARO_MIN_INTERVAL_MS = Number(process.env.DISPARO_MIN_INTERVAL_MS || 1500);
const disparoRateLimit = new Map<number, number>();

import { getDB } from "./database";

// ===============================
// 📦 TIPAGEM DE AGENDAMENTOS
// ===============================
interface ScheduleRow {
  id: number;
  user_id: number;
  numbers: string;
  message: string;
  file: string | null;
  filename: string | null;
  send_at: number;
  recurrence: "none" | "daily" | "weekly" | "monthly";
  recurrence_end: number | null;
  status: "pending" | "sent";
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

const sanitizeNumber = (value: any) => String(value ?? "").replace(/\D/g, "");

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
  const number = sanitizeNumber(raw?.number);
  if (!number) return null;
  const contact: PersonalizedContact = { number };

  if (raw?.message !== undefined) contact.message = String(raw.message);
  const vars = normalizeVars(raw);
  if (Object.keys(vars).length) contact.vars = vars;

  return contact;
};

const buildContactsFromPayload = (contactsArr: any[]): PersonalizedContact[] =>
  Array.isArray(contactsArr)
    ? contactsArr.map(sanitizeContactPayload).filter(Boolean) as PersonalizedContact[]
    : [];

const buildContactsFromStored = (raw: any, baseMessage?: string): PersonalizedContact[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") {
        return { number: sanitizeNumber(item), message: baseMessage };
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
        const dataUrl = `data:${mimetype};base64,${file}`;
        await client.sendFile(chatId, dataUrl, filename, body || "");

        io.to(socket.id).emit("newMessage", {
          chatId,
          body: file,
          mimetype,
          isMedia: true,
          fromMe: true,
          _isFromMe: true,
          timestamp: Date.now()
        });
        return;
      }

      // 💬 ENVIO DE TEXTO
      await client.sendText(chatId, body);

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

  socket.on("chat_human_state", (data: any) => {
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

      const chats = allChats
        .filter((c: any) => c.id?._serialized) // só garante id válido
        .map((c: any) => {
          const chatId = c.id._serialized;

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
        socket.emit("mensagens_chat", []);
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
        socket.emit("mensagens_chat", []);
        return;
      }

      const full = `USER${userId}_${session.session_name}`;
      const client = getClient(full);

      if (!client) {
        socket.emit("mensagens_chat", []);
        return;
      }

      // ==================================================
      // ✅ ABRIR CHAT (SEM loadEarlierMsgs)
      // ==================================================
      await client.openChat(chatId);

      // ⏳ pequeno delay para WhatsApp carregar mensagens em memória
      await new Promise(r => setTimeout(r, 500));

      // ==================================================
      // 📥 BUSCAR MENSAGENS JÁ DISPONÍVEIS
      // ==================================================
      const messages = await client.getAllMessagesInChat(
        chatId,
        true,   // includeMe
        false   // includeNotifications (OBRIGATÓRIO)
      );

      const formatted = messages.map((m: any) => ({
        chatId,
        body: m.body || "",
        mimetype: m.mimetype || null,
        isMedia: !!m.mimetype,
        timestamp: (m.timestamp || Date.now()) * 1000,
        fromMe: m.fromMe === true,
        _isFromMe: m.fromMe === true
      }));

      socket.emit("mensagens_chat", formatted);

    } catch (err) {
      console.error("❌ Erro ao abrir chat:", err);
      socket.emit("mensagens_chat", []);
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

      stopChatSession(Number(userId), session.session_name, chatId);

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
app.get("/auth/auto-login", async (req, res) => {
  const token = req.query.token as string;
  if (!token) return res.status(400).json({ error: "token ausente" });

  const user = await findUserByToken(token);
  if (!user) return res.status(404).json({ error: "token inválido" });

  // Criar cookie novamente automaticamente
  res.cookie("token", user.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,   // localhost
    path: "/",       // 🔥 OBRIGATÓRIO
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
      : [{ number: sanitizeNumber(number), message }];

    if (!contactList.length) {
      return res.status(400).json({ error: "Nenhum número válido" });
    }

    const hasTextMessage = contactList.some((c) => (c.message ?? message ?? "").trim().length > 0);
    if (!file && !hasTextMessage) {
      return res.status(400).json({
        error: "Mensagem ou imagem é obrigatória"
      });
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

        if (!file) {
          await client.sendText(chatId, finalMessage);
          continue;
        }

        const base64 = file.split("base64,")[1];
        const mime = file.substring(
          file.indexOf(":") + 1,
          file.indexOf(";")
        );

        await client.sendFile(
          chatId,
          `data:${mime};base64,${base64}`,
          filename || "arquivo",
          finalMessage // legenda opcional
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
    : numbersArr.map((n) => sanitizeNumber(n)).filter(Boolean);

  if (!normalized.length) return res.status(400).json({ error: "Nenhum número válido" });

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
    [user.id, JSON.stringify(normalized), message, file, filename, sendAtMs, recurrence, recurrenceEndMs]
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

  const db = getDB();
  const existing = await db.get<any>(
    `SELECT * FROM schedules WHERE id = ? AND user_id = ?`,
    [id, user.id]
  );
  if (!existing) return res.status(404).json({ error: "Agendamento não encontrado" });
  if (existing.status !== "pending") {
    return res.status(400).json({ error: "Somente agendamentos pendentes podem ser editados" });
  }

  const normalized = hasPersonalized
    ? contactList
    : numbersArr.map((n) => String(n || "").replace(/\D/g, "")).filter(Boolean);

  if (!normalized.length) return res.status(400).json({ error: "Nenhum número válido" });

  const recurrenceRaw = (recurrence || existing.recurrence || "none") as string;
  const allowed = ["none", "daily", "weekly", "monthly"];
  const finalRecurrence = allowed.includes(recurrenceRaw) ? recurrenceRaw : "none";
  const finalRecurrenceEnd = recurrenceEndMs ?? existing.recurrence_end ?? null;

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

  const finalFile = file ?? (keepExistingFile ? existing.file : null);
  const finalFilename = filename ?? (keepExistingFile ? existing.filename : null);

  await db.run(
    `UPDATE schedules
     SET numbers = ?, message = ?, file = ?, filename = ?, send_at = ?, recurrence = ?, recurrence_end = ?
     WHERE id = ? AND user_id = ?`,
    [
      JSON.stringify(normalized),
      message,
      finalFile,
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
setInterval(async () => {
  const db = getDB();
  const now = Date.now();

  const schedules = await db.all(
    `SELECT * FROM schedules
     WHERE status = 'pending' AND send_at <= ?`,
    [now]
  );

  for (const row of schedules) {
    try {
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

      // =========================
      // 📤 ENVIO DAS MENSAGENS
      // =========================
      for (const contact of contactsList) {
        try {
          // ✅ valida número (SEM @c.us)
          const target = await ensureChat(client, contact.number);
          const finalMessage = renderTemplate(contact.message ?? row.message ?? "", contact);

          if (row.file && row.filename) {
            // 📎 MÍDIA
            await client.sendFile(
              target,
              row.file,
              row.filename,
              finalMessage || ""
            );
          } else {
            // 💬 TEXTO — MÉTODO CORRETO
            await client.sendText(target, finalMessage);
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
        `UPDATE schedules SET status = 'sent' WHERE id = ?`,
        [row.id]
      );

      const recurrence = (row as any).recurrence || "none";
      const recurrenceEnd = (row as any).recurrence_end || null;
      const nextSendAt = calculateNextSendAt(row.send_at, recurrence, recurrenceEnd);

      // 📝 Registrar log de execução
      const sentAt = Date.now();
      await db.run(
        `INSERT INTO schedule_logs (schedule_id, user_id, success_count, failure_count, sent_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, userId, successCount, failureCount, sentAt, sentAt]
      );
      const logResult = await db.get<{ insertId: number }>("SELECT LAST_INSERT_ID() as insertId");
      const logId = logResult?.insertId;
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
        await db.run(
          `INSERT INTO schedules (user_id, numbers, message, file, filename, send_at, recurrence, recurrence_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, row.numbers, row.message, row.file, row.filename, nextSendAt, recurrence, recurrenceEnd]
        );
      }

      console.log("✅ Agendamento enviado:", row.id);

    } catch (err) {
      console.error("❌ Erro geral no agendador:", err);
    }
  }
}, 10000);

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

    await db.run(
      `INSERT INTO crm (user_id, name, phone, citystate, stage, tags, notes, deal_value, follow_up_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        name,
        phone,
        citystate || "",
        stage || "Novo",
        tags || "[]",
        notes || "[]",
        Number(deal_value) || 0,
        follow_up_date ? Number(follow_up_date) : null
      ]
    );

    res.json({ ok: true });
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

    if (!id) return res.json({ ok: false, error: "ID ausente" });

    await db.run(
      `UPDATE crm 
       SET name = ?, phone = ?, citystate = ?, stage = ?, tags = ?, notes = ?, deal_value = ?, follow_up_date = ?
       WHERE id = ?`,
      [
        name,
        phone,
        citystate || "",
        stage || "Novo",
        tags || "[]",
        notes || "[]",
        Number(deal_value) || 0,
        follow_up_date ? Number(follow_up_date) : null,
        id
      ]
    );

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
    const { name, trigger, actions } = req.body;
    if (!name || !trigger || !actions) return res.status(400).json({ ok: false, error: "Dados incompletos" });
    const db = getDB();
    await db.run(
      `INSERT INTO flows (user_id, name, trigger_type, actions)
   VALUES (?, ?, ?, ?)`,
      [user.id, name, trigger, JSON.stringify(actions)]
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
    const { id, name, trigger, actions } = req.body;
    if (!id || !name || !trigger || !actions) return res.status(400).json({ ok: false, error: "Dados incompletos" });
    const db = getDB();
    await db.run(
      `UPDATE flows
   SET name = ?, trigger_type = ?, actions = ?
   WHERE id = ? AND user_id = ?`,
      [name, trigger, JSON.stringify(actions), id, user.id]
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

  // 🔥 cria usuário
  await db.run(
    `INSERT INTO users (
      name, email, password, prompt, token,
      plan, subscription_status, plan_expires_at,
      email_verified, email_verify_token, email_verify_expires
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      hash,
      prompt || "",
      token,
      "free",
      "trial",
      Date.now() + trialDays * 24 * 60 * 60 * 1000,

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

  // ✅ SEMPRE cria o cookie quando login estiver correto
  res.cookie("token", user.token, {
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
app.post("/auth/logout", (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/", // 🔥 OBRIGATÓRIO
  });

  return res.json({ ok: true });
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
