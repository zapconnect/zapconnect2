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

import adminRoutes from "./routes/admin";
import { getChatAI, setChatAI } from "./services/chatAiService";
import emailVerifyRoutes from "./routes/emailVerify";

import { sendVerifyEmail } from "./utils/sendVerifyEmail";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";



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
} from "./wppManager";


import { User } from "./database/types";


const app = express();

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

  socket.on("admin_send_message", async ({ chatId, body }) => {
    try {
      const userId = socket.handshake.auth?.userId;
      if (!userId || !chatId || !body) return;

      const db = getDB();

      // Buscar sessão conectada do usuário
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

      // 🔥 ENVIA PRO WHATSAPP REAL
      await client.sendText(chatId, body);

      // 🔄 Envia de volta para o painel como mensagem "fromMe"
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


  socket.on("chat_human_state", ({ chatId, state, sessionName }) => {
    const userId = socket.handshake.auth?.userId;
    if (!userId || !chatId || !sessionName) return;

    const fullKey = `USER${userId}_${sessionName}`;
    const chatKey = `${fullKey}::${chatId}`;

    if (state === true) {
      // 👤 ativa humano (já cria timer + emite evento)
      enableHumanTemporarily(userId, sessionName, chatId);

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

            // ⏱ expire real (timestamp final)
            expire: isHuman
              ? ((last || Date.now()) + 5 * 60 * 1000)
              : null,
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

    if (!user.email_verify_expires || Date.now() > Number(user.email_verify_expires)) {
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

    // ✅ CRIA COOKIE AUTOMÁTICO
    res.cookie("token", user.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });

    // 🚀 REDIRECIONA DIRETO PRO PAINEL
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

    const { number, message, file, filename } = req.body;
    const user = (req as any).user as User;

    // ===============================
    // ✅ Validações corretas
    // ===============================
    if (!number) {
      return res.status(400).json({ error: "Número é obrigatório" });
    }

    if (!message && !file) {
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

      const chatId = `${number}@c.us`;

      // ===============================
      // 📤 TEXTO PURO
      // ===============================
      if (!file) {
        await client.sendText(chatId, message);
        return res.json({ ok: true });
      }

      // ===============================
      // 📤 MÍDIA (imagem / arquivo)
      // ===============================
      const base64 = file.split("base64,")[1];
      const mime = file.substring(
        file.indexOf(":") + 1,
        file.indexOf(";")
      );

      await client.sendFile(
        chatId,
        `data:${mime};base64,${base64}`,
        filename || "arquivo",
        message || "" // legenda opcional
      );

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
  const { numbers, message, file, filename, sendAt } = req.body;

  if (!numbers?.length || !sendAt)
    return res.status(400).json({ error: "Dados incompletos" });

  const db = getDB();
  await db.run(
    `INSERT INTO schedules (user_id, numbers, message, file, filename, send_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, JSON.stringify(numbers), message, file, filename, sendAt]
  );

  res.json({ ok: true });
});

// Listar agendamentos do usuário
app.get("/api/agendamentos/list", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const db = getDB();
  const rows = await db.all(
    `SELECT * FROM schedules WHERE user_id = ? ORDER BY send_at ASC`,
    [user.id]
  );
  res.json(rows);
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
      const numbers: string[] = JSON.parse(row.numbers || "[]");
      const userId = row.user_id;

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
      for (const rawNumber of numbers) {
        try {
          // ✅ valida número (SEM @c.us)
          const target = await ensureChat(client, rawNumber);

          if (row.file && row.filename) {
            // 📎 MÍDIA
            await client.sendFile(
              target,
              row.file,
              row.filename,
              row.message || ""
            );
          } else {
            // 💬 TEXTO — MÉTODO CORRETO
            await client.sendText(target, row.message);
          }

          // ⏳ delay anti-ban
          await new Promise(r => setTimeout(r, 1200));

        } catch (err: any) {
          console.error(
            "⚠️ Erro envio agendado (número):",
            rawNumber,
            err?.message || err
          );
        }
      }

      // ✅ MARCAR COMO ENVIADO
      await db.run(
        `UPDATE schedules SET status = 'sent' WHERE id = ?`,
        [row.id]
      );

      console.log("✅ Agendamento enviado:", row.id);

    } catch (err) {
      console.error("❌ Erro geral no agendador:", err);
    }
  }
}, 10000);




// ===================================================
// 🧾 CRM KANBAN
// ===================================================



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

    const { name, phone, citystate, stage, tags, notes } = req.body;

    await db.run(
      `INSERT INTO crm (user_id, name, phone, citystate, stage, tags, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        name,
        phone,
        citystate || "",
        stage || "Novo",
        tags || "[]",
        notes || "[]"
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Erro criar CRM:", err);
    res.status(500).json({ ok: false });
  }
});


// Atualizar cliente
app.put("/api/crm/update", authMiddleware, async (req, res) => {
  try {
    const db = getDB();

    const { id, name, phone, citystate, stage, tags, notes } = req.body;

    if (!id) return res.json({ ok: false, error: "ID ausente" });

    await db.run(
      `UPDATE crm 
       SET name = ?, phone = ?, citystate = ?, stage = ?, tags = ?, notes = ?
       WHERE id = ?`,
      [
        name,
        phone,
        citystate || "",
        stage || "Novo",
        tags || "[]",
        notes || "[]",
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
  const LIMIT = 5 * 60 * 1000; // 5 minutos sem cliente falar

  for (const [key, last] of chatHumanLastActivity.entries()) {
    const isHuman = chatHumanLock.get(key) === true;

    if (!isHuman) {
      chatHumanLastActivity.delete(key);
      continue;
    }

    const lastActivity = Number(last || 0);

    if (!lastActivity) {
      chatHumanLastActivity.set(key, now);
      continue;
    }

    if (now - lastActivity >= LIMIT) {
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
