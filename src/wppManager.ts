// ===============================
// 📌 WPP MANAGER MULTI-SESSÃO COMPLETO + STATUS EM TEMPO REAL
// ===============================
import wppconnect from "@wppconnect-team/wppconnect";
import terminalKit from "terminal-kit";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getDB } from "./database";
import { mainOpenAI } from "./service/openai";
import { mainGoogle } from "./service/google";
import { splitMessages, sendMessagesWithDelay } from "./util";
import { io } from "./server";
import { canUseIA, consumeIaMessage } from "./services/iaLimiter";
import { getChatAI } from "./services/chatAiService";



/**
 * Compatível com versões antigas do WPPConnect
 * Não tenta forçar LID manualmente
 */
export async function ensureChat(
  client: any,
  number: string
): Promise<string> {
  const jid = `${number}@c.us`;

  const exists = await client.checkNumberStatus(jid);
  if (!exists || !exists.canReceiveMessage) {
    throw new Error("Número inválido ou não registrado no WhatsApp");
  }

  // ⚠️ MUITO IMPORTANTE:
  // retornamos APENAS o número
  return number;
}






// ... dentro do mesmo arquivo:
async function executeUserFlows(userId: number, chatId: string, messageBody: string, client: any) {
  try {
    const db = await getDB();
    const rows = await db.all(`SELECT * FROM flows WHERE user_id = ?`, [userId]);
    if (!rows || !rows.length) return;

    // busca flows cujo trigger esteja contido (case-insensitive)
    const matched = rows.filter(r => {
      const trig = (r.trigger || "").toLowerCase();
      return trig && messageBody.toLowerCase().includes(trig);
    });

    if (!matched.length) return;

    // executar cada flow (cada um sequencialmente)
    for (const f of matched) {
      const actions = JSON.parse(f.actions || "[]");
      for (const a of actions) {
        if (a.type === "send_text") {
          try { await client.sendText(chatId, String(a.payload || "")); } catch { }
        } else if (a.type === "delay") {
          const s = Number(a.payload) || 1;
          await new Promise(r => setTimeout(r, s * 1000));
        } else if (a.type === "send_media") {
          // espera que payload seja dataURL "data:mime;base64,AAA..."
          try { await client.sendFile(chatId, String(a.payload), "arquivo", ""); } catch { }
        } else if (a.type === "handover_human") {
          // emule envio de mensagem e marque para humano (a lógica de handover você pode integrar aqui)
          try { await client.sendText(chatId, "🔔 Vou transferir você para um atendente humano. Aguarde..."); } catch { }
          // Pode disparar evento para o painel:
          try { (global as any).io?.emit("human_request", { chatId, userId }); } catch { }
        }
      }
    }
  } catch (err) {
    console.error("Erro executar flows:", err);
  }
}


// ===========================
// FUNÇÃO DE SALVAR/ATUALIZAR CLIENTE AUTOMATICAMENTE NO CRM
// ===========================
async function saveCRMClient(userId: number, msg: any) {
  try {
    const db = await getDB();
    const chatId = msg.chatId?.toString();
    if (!chatId || msg.isGroupMsg) return;

    const phone = chatId.replace("@c.us", "");
    const name =
      msg.sender?.pushname ||
      msg.sender?.name ||
      msg.sender?.shortName ||
      phone;

    const avatar = msg.sender?.profilePicThumbObj?.eurl || null;
    const lastSeen = Date.now();

    // Verifica se o cliente já existe para ESTE userId e ESTE telefone
    const existing = await db.get(
      `SELECT id FROM crm WHERE user_id = ? AND phone = ?`,
      [userId, phone]
    );

    if (existing) {
      // Atualiza nome/avatar/last_seen
      await db.run(
        `UPDATE crm 
         SET name = ?, avatar = ?, last_seen = ?
         WHERE id = ?`,
        [name, avatar, lastSeen, existing.id]
      );
    } else {
      // Cria cliente novo incluindo user_id
      await db.run(
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
    }
  } catch (err) {
    console.log("⚠️ Erro ao salvar cliente CRM:", err);
  }

}




// Controle de IA por chat (true = ligado, false = desligado)
// chave = USER{userId}_{chatId}
export const chatAILock = new Map<string, boolean>();
// ⏱ Controle de humano / tempo
export const chatHumanLock = new Map<string, boolean>();
export const chatHumanTimer = new Map<string, NodeJS.Timeout>();



declare global {
  var io: any;
}


const term = terminalKit.terminal;

const AI_SELECTED = (process.env.AI_SELECTED as "GPT" | "GEMINI") || "GEMINI";
const MAX_RETRIES = 3;

const clients = new Map<string, wppconnect.Whatsapp>();

// Evitar eventos duplicados
const eventsAttached = new Set<string>();

// 🔑 Agora todos os mapas são por sessão+chat (full::chatId)
const messageBuffer = new Map<string, string[]>();
const messageTimeouts = new Map<string, NodeJS.Timeout>();
const pausedChats = new Map<string, boolean>();
const humanTimeouts = new Map<string, NodeJS.Timeout>();

// ===========================
// HELPERS
// ===========================
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

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

/** ⏱ Ativa atendimento humano e desativa após 5 min */
export const chatHumanExpire = new Map<string, number>(); // 🆕 <---

export function enableHumanTemporarily(userId: string | number, chatId: string) {
  const key = `USER${userId}_${chatId}`;

  chatHumanLock.set(key, true);


  // 🕒 salva timestamp de expiração
  const expire = Date.now() + 5 * 60 * 1000;
  chatHumanExpire.set(key, expire);

  if (chatHumanTimer.has(key)) clearTimeout(chatHumanTimer.get(key));

  const timer = setTimeout(() => {
    chatHumanLock.set(key, false);
    chatHumanExpire.delete(key);
    chatHumanTimer.delete(key);
    if (global.io) global.io.emit("human_state_changed", { chatId, state: false });
  }, 5 * 60 * 1000);

  chatHumanTimer.set(key, timer);
}

// ===========================
// 🧹 LIMPAR TOKENS INATIVOS
// ===========================
export async function cleanupInactiveTokens() {
  const tokensRoot = path.join(process.cwd(), "tokens");
  ensureDir(tokensRoot);

  const db = await getDB();

  // 🔎 sessões válidas no banco
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

      console.log("🧹 Token inativo encontrado:", dir);

      try {
        const ok = await safeRmDir(fullPath);
        if (ok) {
          removed++;
          console.log("✅ Token removido:", dir);
        } else {
          console.warn("⚠️ Falha ao remover token:", dir);
        }
      } catch (err) {
        console.error("❌ Erro ao remover token:", dir, err);
      }
    }
  }

  console.log(`🧹 Limpeza concluída. Tokens removidos: ${removed}`);
}

// ===========================
// REMOVER PASTA DA SESSÃO (SAFE)
// ===========================
async function safeRmDir(dir: string) {
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
            console.log("💀 Matando Chrome da sessão -> PID", pid);
          } catch { }
        }
      } catch { }
    } else {
      try {
        execSync(`pkill -f "${dir}"`, { stdio: "ignore" });
      } catch { }
    }

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
  const sessionDir = path.join(process.cwd(), "tokens", full);

  console.log("🗑 Apagando sessão COMPLETA:", full);

  try {
    const client = clients.get(full);
    if (client) {
      try {
        await client.close();
      } catch { }
      clients.delete(full);
    }

    // ❌ remover eventos e memória
    eventsAttached.delete(full);
    clearSessionMemory(full);

    // 🗑 remover QR
    const qrPath = getQRPathFor(full);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);

    // 🔥 APAGAR TOKEN (PASTA DA SESSÃO)
    if (fs.existsSync(sessionDir)) {
      const removed = await safeRmDir(sessionDir);
      console.log(
        removed
          ? "🧹 Token (userDataDir) removido"
          : "⚠️ Falha ao remover token"
      );
    }

    // 🧾 remover do banco
    const db = await getDB();
    await db.run(
      `DELETE FROM sessions WHERE user_id = ? AND session_name = ?`,
      [userId, sessionName]
    );

    console.log("✅ Sessão totalmente removida:", full);
    return true;

  } catch (err) {
    console.error("❌ Erro ao apagar sessão:", err);
    return false;
  }
}
function extrairNumero(chatId: string) {
  return chatId.replace("@c.us", "").replace("@g.us", "");
}

// ===============================
// 🔁 FUNÇÃO QUE ANEXA EVENTOS (SEM DUPLICAR) + DIGITANDO + IA + PAINEL
// ===============================
// ===============================
// 🔁 FUNÇÃO QUE ANEXA EVENTOS (SEM DUPLICAR) + MODO HUMANO + IA POR CHAT + DIGITANDO
// ===============================
function attachEvents(
  client: wppconnect.Whatsapp,
  userId: number,
  shortName: string
) {
  const full = `USER${userId}_${shortName}`;

  if (eventsAttached.has(full)) {
    console.log(`⚠️ Eventos já anexados para ${full}, ignorando...`);
    return;
  }
  console.log(`🔁 Anexando eventos para ${full}...`);
  eventsAttached.add(full);

  client.onMessage(async (msg) => {
    // =================================================
    // 🚫 BLOQUEIO TOTAL DE STATUS / STORY (100% SAFE)
    // =================================================
    const chatId = String(msg.chatId || msg.from || "");

    if (chatId === "status@broadcast") {
      return;
    }

    // =================================================
    // 🚫 IGNORAR GRUPOS
    // =================================================
    if (msg.isGroupMsg || chatId.endsWith("@g.us")) {
      return;
    }

    // =================================================
    // 🚫 MENSAGEM INVÁLIDA
    // =================================================
    if (!chatId) return;

    const body = msg.body?.trim() || "";

    // =================================================
    // 🧾 SALVAR / ATUALIZAR CRM
    // =================================================
    try {
      await saveCRMClient(userId, msg);
    } catch { }

    // =================================================
    // 🔑 CHAVES DE CONTROLE
    // =================================================
    const fullKey = `USER${userId}_${shortName}`;
    const chatKey = `${fullKey}::${chatId}`;
    const aiKey = `USER${userId}_${chatId}`;

    // =================================================
    // 📡 ENVIAR PARA O PAINEL (REALTIME)
    // =================================================
    try {
      const { io } = await import("./server");
      io.emit("newMessage", {
        chatId,
        name:
          msg.sender?.pushname ||
          msg.sender?.name ||
          msg.sender?.shortName ||
          chatId.replace("@c.us", ""),
        body: msg.body,
        mimetype: msg.mimetype,
        isMedia: !!msg.mimetype,
        timestamp: (msg.timestamp || Date.now()) * 1000,
        fromMe: msg.fromMe === true,
        _isFromMe: msg.fromMe === true
      });
    } catch { }

    // =================================================
    // 👤 MODO HUMANO ATIVO → NÃO RESPONDER
    // =================================================
    if (chatHumanLock.get(aiKey) === true) {
      messageBuffer.delete(chatKey);

      // 🔴 GARANTE que não fica digitando
      try { await client.stopTyping(chatId); } catch { }

      return;
    }

    // =================================================
    // 🤖 IA DESLIGADA PARA ESTE CHAT
    // =================================================
    const aiEnabledForChat = await getChatAI(userId, chatId);
    if (!aiEnabledForChat) {
      messageBuffer.delete(chatKey);

      // 🔴 GARANTE que não fica digitando
      try { await client.stopTyping(chatId); } catch { }

      return;
    }

    // =================================================
    // 🔐 LIMITE DE PLANO IA
    // =================================================
    if (!(await canUseIA(userId))) {
      // 🔴 GARANTE que não fica digitando
      try { await client.stopTyping(chatId); } catch { }

      await client.sendText(
        chatId,
        "⚠️ Você atingiu o limite de mensagens IA do seu plano.\n\nFaça upgrade para continuar 🚀"
      );
      return;
    }

    // =================================================
    // 🔁 EXECUTAR FLOWS INTELIGENTES
    // =================================================
    try {
      await executeUserFlows(userId, chatId, body, client);
    } catch { }

    // =================================================
    // 💬 BUFFER DE MENSAGENS
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
      let typingTimeout: NodeJS.Timeout | null = null;

      try {
        const db = await getDB();

        const userConfig = await db.get(
          `SELECT prompt, ia_enabled FROM users WHERE id = ?`,
          [userId]
        );

        // ❌ IA GLOBAL DESLIGADA
        if (!userConfig?.ia_enabled) {
          messageBuffer.delete(chatKey);

          // 🔴 GARANTE que não fica digitando
          try { await client.stopTyping(chatId); } catch { }

          return;
        }

        // =================================================
        // ✍️ DIGITANDO (SÓ AQUI! DEPOIS DE CONFIRMAR QUE VAI RESPONDER)
        // =================================================
        try {
          await client.startTyping(chatId);
        } catch { }

        typingTimeout = setTimeout(() => {
          try {
            client.stopTyping(chatId);
          } catch { }
        }, 8000);

        const prompt = userConfig?.prompt || "";
        const buffer = messageBuffer.get(chatKey) || [];

        const finalMessage = `${prompt}\n\n${buffer.join("\n")}`;

        let response = "";

        for (let i = 1; i <= MAX_RETRIES; i++) {
          try {
            response =
              AI_SELECTED === "GPT"
                ? await mainOpenAI({ currentMessage: finalMessage, chatId })
                : await mainGoogle({
                  currentMessage: finalMessage,
                  chatId,
                  userId,
                  sessionName: shortName,
                  promptUsuario: prompt
                });
            break;
          } catch (err) {
            if (i === MAX_RETRIES) {
              response = "❌ Erro ao responder no momento.";
            }
          }
        }

        const messages = splitMessages(response);

        await sendMessagesWithDelay({
          client,
          messages,
          targetNumber: msg.from
        });

        // ✅ CONSUMIR 1 MENSAGEM IA
        await consumeIaMessage(userId);

      } catch (err) {
        console.error("❌ Erro no debounce IA:", err);
      } finally {
        // 🧹 limpar tudo
        messageBuffer.delete(chatKey);

        if (typingTimeout) clearTimeout(typingTimeout);

        // 🔴 GARANTE que para SEMPRE
        try { await client.stopTyping(chatId); } catch { }
      }
    }, 1000);

    messageTimeouts.set(chatKey, timeout);
  });




}




// ===========================
// CRIAR SESSÃO + STATUS EM TEMPO REAL
// ===========================
export async function createWppSession(
  userId: number,
  shortName: string
): Promise<{ sessionName: string; exists?: boolean }> {
  const full = `USER${userId}_${shortName}`;
  const sessionDir = path.join(process.cwd(), "tokens", full);

  if (clients.has(full)) {
    console.log("⚠️ Sessão já está carregada:", full);
    return { sessionName: full, exists: true };
  }

  ensureDir(path.join(process.cwd(), "qr"));
  ensureDir(path.join(process.cwd(), "tokens"));

  console.log("📱 Criando sessão:", full);

  const client = await wppconnect.create({
    session: full,
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
        `--user-data-dir=${sessionDir}`,
      ],
    },
    catchQR: async (base64Qrimg, asciiQR, attempts, urlCode) => {
      console.log(`📡 QR (${full}) tentativa ${attempts}`);
      console.log("📸 QR salvo em:", getQRPathFor(full));
      if (base64Qrimg) {
        const base64 = base64Qrimg.split("base64,")[1];
        fs.writeFileSync(getQRPathFor(full), Buffer.from(base64, "base64"));
      }

      try {
        const { io } = await import("./server");
        io.emit("session:qr", { userId, sessionName: shortName, full });
      } catch { }

      if (urlCode) term(await qrcode.toString(urlCode, { type: "terminal" }));
    },
    statusFind: async (status) => {
      console.log("🧠 STATUS FIND DISPAROU:", status);

      const db = await getDB();

      if (["inChat", "qrReadSuccess", "connected"].includes(status)) {
        console.log("🟢 WHATSAPP CONECTADO — EMITINDO server:online");

        await db.run(
          `UPDATE sessions SET status = 'connected' WHERE user_id = ? AND session_name = ?`,
          [userId, shortName]
        );

        try {
          const { io } = await import("./server");
          console.log("📡 io existe?", !!io);
          io.emit("server:online", { userId });
        } catch (err) {
          console.error("❌ ERRO AO EMITIR server:online", err);
        }
      }

      if (["browserClose", "disconnectedMobile", "serverClose"].includes(status)) {
        console.log("🔴 WHATSAPP DESCONECTADO — EMITINDO server:offline");

        await db.run(
          `UPDATE sessions SET status = 'disconnected' WHERE user_id = ? AND session_name = ?`,
          [userId, shortName]
        );

        try {
          const { io } = await import("./server");
          io.emit("server:offline", { userId });
        } catch (err) {
          console.error("❌ ERRO AO EMITIR server:offline", err);
        }
      }
    }


  });

  attachEvents(client, userId, shortName);

  client.onStateChange(async (state) => {
    console.log(`🌐 Estado da sessão ${full}:`, state);

    // 📡 Emitir estado exato (conexão, reconexão, etc.)
    try {
      const { io } = await import("./server");
      io.emit("session:stateChange", {
        userId,
        sessionName: shortName,
        full,
        state,
      });
    } catch { }
  });

  clients.set(full, client);
  return { sessionName: full };
}

// ===========================
// GET CLIENT
// ===========================
export function getClient(full: string) {
  return clients.get(full);
}
