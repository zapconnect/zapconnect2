// src/server.ts
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import http from "http";
import cookieParser from "cookie-parser";
import { Server } from "socket.io";
import bcrypt from "bcrypt";
import { ensureChat } from "./wppManager";
import subscriptionRoutes from "./routes/subscription";

import webhookRoutes from "./routes/webhook";
import { subscriptionGuard } from "./middlewares/subscriptionGuard";

import adminRoutes from "./routes/admin";
import { getChatAI, setChatAI } from "./services/chatAiService";



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
  chatHumanExpire,
  createWppSession,
  getQRPathFor,
  deleteWppSession,
  getClient,
  chatAILock,
  enableHumanTemporarily,
  chatHumanLock, // 👈 importa o mesmo Map usado no bot
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
app.use(
  "/webhook/stripe",
  express.raw({ type: "application/json" })
);




// =======================================
// 🌐 Middlewares globais
// =======================================
app.use(cookieParser());
app.use(express.json());
// ⚠️ OBRIGATÓRIO: antes das rotas normais
app.use("/webhook", webhookRoutes);
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
  socket.on("chat_human_state", ({ chatId, state }) => {
    const userId = socket.handshake.auth?.userId;
    if (!userId || !chatId) return;

    const key = `USER${userId}_${chatId}`;

    if (state === true) {
      // 👤 Ativar modo humano por 5 minutos
      chatHumanLock.set(key, true);

      const expire = Date.now() + 5 * 60 * 1000;
      chatHumanExpire.set(key, expire);

      io.emit("human_state_changed", {
        chatId,
        state: true,
        expire
      });
    } else {
      // 🤖 Voltar para o bot
      chatHumanLock.set(key, false);
      chatHumanExpire.delete(key);

      io.emit("human_state_changed", {
        chatId,
        state: false
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
          const key = `USER${userId}_${chatId}`;

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
            human: chatHumanLock.get(key) === true,

            // 🤖 estado real da IA vindo do banco
            ai: true,

            // ⏱ expiração real
            expire: chatHumanExpire.get(key) || null
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
  console.log("🍪 Cookies recebidos:", req.cookies);

  const token = req.cookies?.token;

  if (!token) {
    console.log("❌ Sem token");
    return res.redirect("/login");
  }

  const db = getDB();
  const user = await db.get(
    "SELECT * FROM users WHERE token = ?",
    [token]
  );

  if (!user) {
    console.log("❌ Token inválido");
    return res.redirect("/login");
  }

  console.log("✅ Usuário autenticado:", user.email);

  (req as any).user = user;
  next();
}


// =======================================
// 📌 Rotas de Páginas (EJS)
// =======================================
// 👤 Página do usuário / assinatura
app.get("/user", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const db = getDB();

  // 🔹 Últimos pagamentos do usuário
  const payments = await db.all(
    `
    SELECT
      amount,
      status,
      payment_method,
      created_at
    FROM payments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 5
    `,
    [user.id]
  );

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

app.get("/painel", authMiddleware, async (req: Request, res: Response) => {
  const user = (req as any).user as User;
  const db = getDB();

  const sessions = await db.all(
    `SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC`,
    [user.id]
  );

  const API_URL =
    process.env.API_URL || `${req.protocol}://${req.get("host")}`;

  // 🔥 Salvar cookie automaticamente
  res.cookie("token", user.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,   // localhost
    path: "/",       // 🔥 OBRIGATÓRIO
  });



  // 🔥 Renderiza já enviando token para JS colocar no localStorage
  res.render("painel", { user, sessions, API_URL });
});
app.get("/auth/me", authMiddleware, (req, res) => {
  res.json({ user: (req as any).user });
});

app.get("/", (_req, res) => res.redirect("/painel"));
app.get("/register", (_req, res) => {
  res.render("register");
});

app.get("/index.html", (_req, res) => res.redirect("/login"));

app.get("/chat", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("chat", { user });
});
// 📌 Página CRM Kanban
app.get("/crm", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.render("crm", { user });
});

app.get("/api/crm/list", authMiddleware, async (req, res) => {
  try {
    const db = getDB();
    const rows = await db.all("SELECT * FROM crm ORDER BY id DESC");

    const parsed = rows.map((r: any) => ({
      ...r,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags,
      notes: typeof r.notes === "string" ? JSON.parse(r.notes) : r.notes,
    }));

    res.json(parsed);
  } catch (err) {
    res.json([]);
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



// ===================================================
// 📣 API de DISPARO EM MASSA
// ===================================================
app.post("/api/disparo", authMiddleware, subscriptionGuard, async (req: Request, res: Response) => {
  const { number, message, file, filename } = req.body;
  const user = (req as any).user as User;

  if (!number || !message) {
    return res.status(400).json({ error: "Número e mensagem são obrigatórios" });
  }

  try {
    const db = getDB();
    const sessions = await db.all(
      `SELECT session_name FROM sessions WHERE user_id = ? AND status = 'connected'`,
      [user.id]
    );

    if (!sessions.length) {
      return res.status(400).json({ error: "Nenhuma sessão ativa para este usuário." });
    }

    // 🎯 Pega apenas a 1ª sessão conectada
    const full = `USER${user.id}_${sessions[0].session_name}`;
    const client = getClient(full);

    if (!client) {
      return res.status(400).json({ error: "Sessão não encontrada/indisponível." });
    }

    // ======================================
    // 📤 ENVIO SEM MÍDIA
    // ======================================
    if (!file) {
      await client.sendText(`${number}@c.us`, message);
      return res.json({ ok: true });
    }

    // ======================================
    // 📤 ENVIO COM MÍDIA
    // ======================================
    const base64 = file.split("base64,")[1];
    const mime = file.substring(file.indexOf(":") + 1, file.indexOf(";"));

    await client.sendFile(
      `${number}@c.us`,
      `data:${mime};base64,${base64}`,
      filename || "arquivo",
      message
    );

    res.json({ ok: true });

  } catch (err) {
    console.error("⚠️ Erro no disparo:", err);
    res.status(500).json({ error: "Erro ao enviar mensagem." });
  }
});
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
    const db = getDB();
    const { id, stage } = req.body;

    await db.run(
      `UPDATE crm SET stage = ? WHERE id = ?`,
      [stage, id]
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
    const db = getDB();

    const { name, phone, citystate, stage, tags, notes } = req.body;

    await db.run(
      `INSERT INTO crm (name, phone, citystate, stage, tags, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
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
    console.error(err);
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

  await db.run(
    `INSERT INTO users (
     name, email, password, prompt, token,
     plan, subscription_status, plan_expires_at
   )
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      email,
      hash,
      prompt || "",
      token,
      "free",
      "trial",
      Date.now() + trialDays * 24 * 60 * 60 * 1000
    ]
  );


  res.json({ ok: true });
});



// Login

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body; // ✅ ESTA LINHA É OBRIGATÓRIA

  if (requireFields(res, { email, password })) return;

  const db = getDB();

  const user = await db.get<any>(
    "SELECT * FROM users WHERE email = ?",
    [email]
  );

  if (!user) {
    return res.json({ error: "Usuário não encontrado" });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.json({ error: "Senha inválida" });
  }

  res.cookie("token", user.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,   // localhost
    path: "/",       // 🔥 OBRIGATÓRIO
  });


  res.json({ ok: true });
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
  const sessions = await db.all(`SELECT * FROM sessions WHERE status != 'deleted'`);

  console.log(`🔄 Restaurando ${sessions.length} sessões...`);

  for (const s of sessions) {
    try {
      await createWppSession(s.user_id, s.session_name);
    } catch {
      console.warn(`⚠️ Falhou ao restaurar ${s.session_name}`);
    }
  }

  console.log("✅ Restauração concluída.");
}


// =======================================
// 🚀 Iniciar servidor
// =======================================
server.listen(3000, () => {
  console.log("🚀 Server online em http://localhost:3000");
});
