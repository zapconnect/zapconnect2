// ===============================
// 📌 WPP MANAGER MULTI-SESSÃO COMPLETO + STATUS EM TEMPO REAL
// ===============================
import wppconnect from "@wppconnect-team/wppconnect";
import terminalKit from "terminal-kit";
import qrcode from "qrcode";
import axios from "axios";
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
import {
  checkFallbackTriggers,
  clearFallbackRuntime,
  primeFallbackCache,
  type FallbackDecision,
} from "./services/fallbackService";





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
        console.log("🧹 Lock removido:", file);
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
async function executeUserFlows(
  userId: number,
  sessionName: string,
  chatId: string,
  messageBody: string,
  client: any
) {
  try {
    const db = await getDB();
    const rows = await db.all(`SELECT * FROM flows WHERE user_id = ?`, [userId]);
    if (!rows || !rows.length) return;

    const matched = rows.filter((r) => {
      const trig = (r.trigger || "").toLowerCase();
      return trig && messageBody.toLowerCase().includes(trig);
    });

    if (!matched.length) return;

    for (const f of matched) {
      const actions = JSON.parse(f.actions || "[]");

      for (const a of actions) {
        if (a.type === "send_text") {
          try {
            await client.sendText(chatId, String(a.payload || ""));
          } catch { }
        }

        else if (a.type === "delay") {
          const s = Number(a.payload) || 1;
          await new Promise((r) => setTimeout(r, s * 1000));
        }

        else if (a.type === "send_media") {
          try {
            await client.sendFile(chatId, String(a.payload), "arquivo", "");
          } catch { }
        }

        else if (a.type === "handover_human") {
          try {
            await client.sendText(
              chatId,
              "🔔 Vou transferir você para um atendente humano. Aguarde..."
            );
          } catch { }

          // ✅ ATIVA MODO HUMANO (DESLIGA IA)
          try {
            enableHumanTemporarily(userId, sessionName, chatId);
          } catch { }

          // painel
          try {
            global.io?.emit("human_request", { chatId, userId, sessionName });
          } catch { }
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




declare global {
  var io: any;
}


const term = terminalKit.terminal;

const AI_SELECTED = (process.env.AI_SELECTED as "GPT" | "GEMINI") || "GEMINI";
const MAX_RETRIES = 3;

const clients = new Map<string, wppconnect.Whatsapp>();

// Evitar eventos duplicados
const eventsAttached = new Set<string>();
// ===========================
// 🔁 AUTO RECONNECT CONTROL
// ===========================
const reconnecting = new Set<string>();
const reconnectAttempts = new Map<string, number>();

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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



// 🔑 Agora todos os mapas são por sessão+chat (full::chatId)
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

  console.log("🧹 IA debounce cancelado:", chatKey);
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
// 👤 MODO HUMANO POR INATIVIDADE (5 MIN) — MULTI-SESSÃO
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

/**
 * 🔥 Ativa modo humano
 * Expira quando ficar 5 min sem mensagem do cliente.
 */
export function enableHumanTemporarily(
  userId: string | number,
  sessionName: string,
  chatId: string,
  durationMs: number | null = HUMAN_INACTIVITY_DEFAULT_MS,  // null = sem limite
  customMessage?: string
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

  // ✅ MENSAGEM AUTOMÁTICA NO WHATSAPP
  const messageToSend =
    typeof customMessage === "string" && customMessage.trim().length > 0
      ? customMessage
      : "👤 Conversa transferida para um atendente humano.";

  if (messageToSend) {
    sendSystemMessage(
      userId,
      sessionName,
      chatId,
      messageToSend
    );
  }

  try {
    global.io?.emit("human_state_changed", {
      chatId,
      userId,
      sessionName,
      state: true,
      expireAt: durationMs !== null ? Date.now() + durationMs : null
    });

  } catch { }

  console.log(`👤 MODO HUMANO ATIVADO: ${key} | duração: ${durationMs === null ? "sem limite" : durationMs / 60000 + "min"}`);
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

  // ✅ ATUALIZA PAINEL AO VIVO com a duração correta
  try {
    global.io?.emit("human_state_changed", {
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
  // ✅ DESATIVOU MODO HUMANO
  // ===========================
  chatHumanLock.set(key, false);
  chatHumanLastActivity.delete(key);

  if (chatHumanTimer.has(key)) {
    clearTimeout(chatHumanTimer.get(key)!);
    chatHumanTimer.delete(key);
  }

  // ===========================
  // ✅ AVISA NO WHATSAPP (VOLTOU PRO BOT)
  // ===========================
  sendSystemMessage(
    userId,
    sessionName,
    chatId,
    "🤖 Conversa transferida para o assistente automático."
  );

  // ===========================
  // ✅ AVISA O PAINEL
  // ===========================
  try {
    global.io?.emit("human_state_changed", {
      chatId,
      userId,
      sessionName,
      state: false,
      expireAt: null,
    });
  } catch { }

  console.log(`🤖 BOT reassumiu por inatividade: ${key}`);
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
    decision.config.fallbackMessage
  );

  clearFallbackRuntime(userId, sessionName, chatId);

  if (decision.config.notifyPanel !== false) {
    try {
      io.emit("fallback_triggered", {
        chatId,
        userId,
        sessionName,
        reason: decision.reason,
        configUsed: decision.config.source === "db",
      });
    } catch { }
  }

  if (decision.config.notifyWebhook && decision.config.webhookUrl) {
    try {
      await axios.post(
        decision.config.webhookUrl,
        {
          chatId,
          userId,
          sessionName,
          reason: decision.reason,
          configUsed: decision.config.source === "db",
          triggeredAt: Date.now(),
        },
        { timeout: 5000 }
      );
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
      const targetNumber = await ensureChat(client, numberOnly);
      await client.sendText(`${targetNumber}@c.us`, msg);
    } catch (err) {
      console.error("Erro ao enviar alerta de fallback por WhatsApp:", err);
    }
  }

  console.log(`⚠️ Fallback automático → humano | ${humanKey} | motivo: ${decision.reason}`);
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
  const TOKENS_DIR = process.env.TOKENS_DIR || "/app/tokens";
  const sessionDir = path.join(TOKENS_DIR, full);

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
    let typingTimeout: NodeJS.Timeout | null = null;

    // =================================================
    // 🚫 BLOQUEIO TOTAL DE STATUS / STORY (100% SAFE)
    // =================================================
    const chatId = String(msg.chatId || msg.from || "");
    if (chatId === "status@broadcast") return;

    // =================================================
    // 🚫 IGNORAR GRUPOS
    // =================================================
    if (msg.isGroupMsg || chatId.endsWith("@g.us")) return;

    // =================================================
    // 🚫 NÃO RESPONDER MENSAGEM DO PRÓPRIO BOT (ANTI-LOOP)
    // =================================================
    if (msg.fromMe === true) return;

    // =================================================
    // 🚫 MENSAGEM INVÁLIDA
    // =================================================
    if (!chatId) return;

    // =================================================
    // 🎧 DETECTAR ÁUDIO
    // =================================================
    const isAudio =
      msg.type === "ptt" ||
      msg.type === "audio" ||
      (msg.mimetype && String(msg.mimetype).includes("audio"));

    // =================================================
    // 🧾 BODY / TEXTO (inclui transcrição do WhatsApp)
    // =================================================
    const rawBody = String(msg.body || "").trim();
    const rawCaption = String((msg as any).caption || "").trim();
    const rawText = String((msg as any).text || "").trim();

    // =================================================
    // 🧠 PEGAR TEXTO FINAL
    // - Se for áudio: tenta usar transcrição do WhatsApp
    // - Se for texto normal: usa body normal
    // =================================================
    let body = "";

    // Texto normal
    if (!isAudio) {
      body = rawBody || rawText || rawCaption;
    }

    // Áudio -> só responde se tiver transcrição
    if (isAudio) {
      body = rawBody || rawCaption || rawText;

      // ❌ áudio sem transcrição -> ignora
      if (!body) return;
    }

    // =================================================
    // 🚫 NÃO RESPONDER MENSAGEM VAZIA
    // =================================================
    body = body.trim();
    if (!body) return;

    try {
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
      const humanKey = getHumanKey(userId, shortName, chatId);



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
          fromMe: !!msg.fromMe,
          _isFromMe: !!msg.fromMe,
        });
      } catch { }

      // =================================================
      // 👤 MODO HUMANO ATIVO → NÃO RESPONDER
      // MAS: atualiza atividade para expirar por INATIVIDADE
      // =================================================
      if (chatHumanLock.get(humanKey) === true) {
        // 🔥 zera timer de inatividade (cliente falou)
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
      // 🤖 IA DESLIGADA PARA ESTE CHAT
      // =================================================
      const aiEnabledForChat = await getChatAI(userId, chatId);
      if (!aiEnabledForChat) {
        messageBuffer.delete(chatKey);
        try {
          await client.stopTyping(chatId);
        } catch { }
        return;
      }

      // =================================================
      // 🌙 HORÁRIO DE SILÊNCIO
      // =================================================
      try {
        const db = await getDB();
        const uCfg = await db.get<{
          ia_silence_start: number | null;
          ia_silence_end: number | null;
        }>(`SELECT ia_silence_start, ia_silence_end FROM users WHERE id = ?`, [userId]);

        if (uCfg?.ia_silence_start !== null && uCfg?.ia_silence_end !== null) {
          const nowHour = new Date().getHours();
          const s = Number(uCfg.ia_silence_start);
          const e = Number(uCfg.ia_silence_end);

          // Intervalo pode cruzar meia-noite (ex: 22–8)
          const inSilence = s <= e
            ? nowHour >= s && nowHour < e          // ex: 9–17
            : nowHour >= s || nowHour < e;          // ex: 22–8

          if (inSilence) {
            console.log(`🌙 IA silenciada (${s}h–${e}h) para user ${userId}`);
            messageBuffer.delete(chatKey);
            return;
          }
        }
      } catch { }

      // =================================================
      // 🔐 LIMITE DE PLANO IA
      // =================================================
      if (!(await canUseIA(userId))) {
        try {
          await client.stopTyping(chatId);
        } catch { }

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
        await executeUserFlows(userId, shortName, chatId, body, client)

      } catch { }

      // =================================================
      // 🆘 FALLBACK AUTOMÁTICO (triggers de mensagem)
      // =================================================
      try {
        const fallbackDecision = await checkFallbackTriggers({
          userId,
          sessionName: shortName,
          chatId,
          event: "user_message",
          message: body,
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

          // ❌ IA GLOBAL DESLIGADA
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
          // ✍️ DIGITANDO (SÓ AQUI! DEPOIS DE CONFIRMAR QUE VAI RESPONDER)
          // =================================================
          try {
            await client.startTyping(chatId);
          } catch { }

          // 📡 Avisar o painel que a IA está digitando
          try {
            const { io } = await import("./server");
            io.emit("typing:start", { chatId, userId, sessionName: shortName });
          } catch { }

          typingTimeout = setTimeout(() => {
            try {
              client.stopTyping(chatId);
            } catch { }
          }, 8000);

          const finalMessage = `${prompt}\n\n${buffer.join("\n")}`;

          let response = "";
          let aiFailed = false;

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
                    promptUsuario: prompt,
                  });
              break;
            } catch (err) {
              if (i === MAX_RETRIES) {
                aiFailed = true;
                response = "❌ Erro ao responder no momento.";
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

          // ✅ CONSUMIR 1 MENSAGEM IA
          await consumeIaMessage(userId);
        } catch (err) {
          console.error("❌ Erro no debounce IA:", err);
        } finally {
          // 🧹 limpar tudo
          messageBuffer.delete(chatKey);

          if (typingTimeout) clearTimeout(typingTimeout);

          // 🔴 GARANTE que para SEMPRE
          try {
            await client.stopTyping(chatId);
          } catch { }

          // 📡 Avisar o painel que a IA parou de digitar
          try {
            const { io } = await import("./server");
            io.emit("typing:stop", { chatId, userId, sessionName: shortName });
          } catch { }
        }
      }, 1000);

      messageTimeouts.set(chatKey, timeout);
    } catch (err) {
      console.error("❌ Erro no onMessage:", err);

      // 🔴 GARANTE stopTyping em erro também
      try {
        await client.stopTyping(chatId);
      } catch { }
    }
  });

}
// ===========================
// 🔁 RECONNECT SESSION
// ===========================
async function reconnectSession(userId: number, shortName: string) {
  const full = `USER${userId}_${shortName}`;

  if (reconnecting.has(full)) {
    console.log("⚠️ Reconexão já em andamento:", full);
    return;
  }

  reconnecting.add(full);

  try {
    const attempts = (reconnectAttempts.get(full) || 0) + 1;
    reconnectAttempts.set(full, attempts);

    // backoff simples (2s, 5s, 10s, 20s, 30s...)
    const delay = Math.min(30000, attempts === 1 ? 2000 : attempts * 5000);

    console.log(`🔁 Tentando reconectar ${full} (tentativa ${attempts}) em ${delay}ms...`);
    await wait(delay);

    // fecha client antigo se existir
    const old = clients.get(full);
    if (old) {
      try {
        await old.close();
      } catch { }
      clients.delete(full);
    }

    // remove eventos e memória
    eventsAttached.delete(full);
    clearSessionMemory(full);

    // atualiza status no banco
    try {
      const db = await getDB();
      await db.run(
        `UPDATE sessions SET status = 'reconnecting' WHERE user_id = ? AND session_name = ?`,
        [userId, shortName]
      );
    } catch { }

    // recria sessão com o MESMO token
    console.log("🚀 Recriando sessão:", full);
    await createWppSession(userId, shortName);

    console.log("✅ Reconexão concluída:", full);
  } catch (err) {
    console.error("❌ Falha ao reconectar:", full, err);
  } finally {
    reconnecting.delete(full);
  }
}

// ===========================
// CRIAR SESSÃO + STATUS EM TEMPO REAL
// ===========================
export async function createWppSession(
  userId: number,
  shortName: string
): Promise<{ sessionName: string; exists?: boolean }> {
  const full = `USER${userId}_${shortName}`;
  const TOKENS_DIR = process.env.TOKENS_DIR || "tokens";
  const sessionDir = path.join(TOKENS_DIR, full);

  if (clients.has(full)) {
    console.log("⚠️ Sessão já está carregada:", full);
    await primeFallbackCache(userId, shortName);
    return { sessionName: full, exists: true };
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
  console.log("📱 Criando sessão:", full);

  const client = await wppconnect.create({
    session: full,

    // 🔥 ADICIONE ISSO
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

    // ===========================
    // 🔁 AUTO RECONNECT
    // ===========================
    try {
      if (isDisconnectedState(state)) {
        console.log("🔴 Estado indica desconexão -> auto-reconnect:", full);

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
          const { io } = await import("./server");
          io.emit("server:offline", { userId });
        } catch { }

        // tenta reconectar
        reconnectSession(userId, shortName);
      }

      // reset tentativas quando conectar
      if (String(state).toLowerCase().includes("connected")) {
        reconnectAttempts.delete(full);
      }
    } catch { }
  });


  clients.set(full, client);
  await primeFallbackCache(userId, shortName);
  return { sessionName: full };
}



// ===========================
// GET CLIENT
// ===========================
export function getClient(full: string) {
  return clients.get(full);
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
      console.log("⚠️ Não achei client pra enviar mensagem:", full);
      return;
    }

    await client.sendText(chatId, text);
  } catch (err) {
    console.log("❌ Erro ao enviar mensagem do sistema:", err);
  }
}
