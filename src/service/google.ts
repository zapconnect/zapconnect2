// =====================================
// 🤖 Gemini Multiusuário + Multi-Sessão
// =====================================
import { GoogleGenerativeAI, type ChatSession } from '@google/generative-ai';
import dotenv from 'dotenv';
import { getDB } from '../database';
dotenv.config();

const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY!);
const model = genAI.getGenerativeModel({ model: MODEL_ID });
const GEMINI_429_BACKOFF = [10_000, 30_000, 60_000];

// Histórico das conversas (por sessão completa)
type ChatHistory = {
  role: 'user' | 'model';
  parts: { text: string }[];
}[];

type CachedHistory = { history: ChatHistory; expiresAt: number };

const CHAT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos
const activeChats = new Map<string, CachedHistory>();
const PERSIST_DEBOUNCE_MS = 3000; // 3s sem novas mensagens -> grava
const PERSIST_FORCE_EVERY = 10; // gravação forçada a cada 10 mensagens
const CHAT_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias
const CHAT_HISTORY_MAX_PER_USER = 500; // cap por usuário (mais recente primeiro)
const CHAT_HISTORY_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // no máx. 1x a cada 6h por usuário
type PersistState = {
  timer?: NodeJS.Timeout;
  pendingCount: number;
  lastHistory: ChatHistory;
  userId: number | string;
  sessionName: string;
  chatId: string;
};
const persistQueue = new Map<string, PersistState>();
const HISTORY_MAX_TURNS = 32; // user+model entries
const HISTORY_MAX_CHARS = 12000; // heurística simples (~3k tokens)
const historyCleanupMarkers = new Map<number, number>(); // userId -> last cleanup timestamp

// =======================================
// 🔑 Create Key: user + session + chat ID
// =======================================
const normalizeUserId = (userId: number | string) => String(userId).trim();

const buildChatKey = (
  userId: number | string,
  sessionName: string,
  chatId: string
) => `USER${normalizeUserId(userId)}_${sessionName}::${chatId}`;

const getCachedHistory = (chatKey: string): ChatHistory | null => {
  const cached = activeChats.get(chatKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    activeChats.delete(chatKey);
    return null;
  }
  return cached.history;
};

const setCachedHistory = (chatKey: string, history: ChatHistory) => {
  activeChats.set(chatKey, { history, expiresAt: Date.now() + CHAT_CACHE_TTL_MS });
};

const flushPersist = async (chatKey: string) => {
  const state = persistQueue.get(chatKey);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  persistQueue.delete(chatKey);
  await persistHistory({
    userId: state.userId,
    sessionName: state.sessionName,
    chatId: state.chatId,
    history: state.lastHistory,
  });
};

const queuePersist = ({
  chatKey,
  userId,
  sessionName,
  chatId,
  history,
}: {
  chatKey: string;
  userId: number | string;
  sessionName: string;
  chatId: string;
  history: ChatHistory;
}) => {
  const trimmed = trimHistory(history);
  setCachedHistory(chatKey, trimmed);

  const existing = persistQueue.get(chatKey);
  const pendingCount = (existing?.pendingCount ?? 0) + 1;

  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    flushPersist(chatKey).catch((err) =>
      console.warn("Falha ao persistir histórico (debounce):", err)
    );
  }, PERSIST_DEBOUNCE_MS);

  persistQueue.set(chatKey, {
    userId,
    sessionName,
    chatId,
    pendingCount,
    lastHistory: trimmed,
    timer,
  });

  if (pendingCount >= PERSIST_FORCE_EVERY) {
    flushPersist(chatKey).catch((err) =>
      console.warn("Falha ao persistir histórico (forçado):", err)
    );
  }
};

async function loadHistoryFromDB({
  userId,
  sessionName,
  chatId,
}: {
  userId: number | string;
  sessionName: string;
  chatId: string;
}): Promise<ChatHistory | null> {
  try {
    const numericUserId = Number(userId);
    const db = getDB();
    const row = await db.get<{ history: string | null }>(
      `SELECT history FROM chat_histories WHERE user_id = ? AND session_name = ? AND chat_id = ?`,
      [numericUserId, sessionName, chatId]
    );
    if (!row?.history) return null;
    const parsed = JSON.parse(row.history);
    if (!Array.isArray(parsed)) return null;
    return parsed as ChatHistory;
  } catch (err) {
    console.warn('Não foi possível carregar histórico do banco:', err);
    return null;
  }
}

async function persistHistory({
  userId,
  sessionName,
  chatId,
  history,
}: {
  userId: number | string;
  sessionName: string;
  chatId: string;
  history: ChatHistory;
}) {
  try {
    const numericUserId = Number(userId);
    const db = getDB();
    const trimmed = trimHistory(history);
    await db.run(
      `
      INSERT INTO chat_histories (user_id, session_name, chat_id, history)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE history = VALUES(history), updated_at = CURRENT_TIMESTAMP
      `,
      [numericUserId, sessionName, chatId, JSON.stringify(trimmed)]
    );

    maybeCleanupChatHistory(numericUserId);
  } catch (err) {
    console.warn('Não foi possível salvar histórico no banco:', err);
  }
}

// =======================================
// 📌 Iniciar/Retomar Sessão Gemini
// =======================================
const getOrCreateChatSession = async ({
  chatKey,
  promptUsuario,
  userId,
  sessionName,
  chatId,
}: {
  chatKey: string;
  promptUsuario: string;
  userId: number;
  sessionName: string;
  chatId: string;
}): Promise<ChatSession> => {
  // Fonte primária: banco. Cache em memória só para aliviar leituras repetidas.
  let history: ChatHistory | null = await loadHistoryFromDB({ userId, sessionName, chatId });

  // Fallback para cache recente (TTL 30 min) apenas se banco não tiver nada
  if (!history || !history.length) {
    history = getCachedHistory(chatKey);
  }

  if (!history || !history.length) {
    history = [
      {
        role: 'user',
        parts: [{ text: promptUsuario }],
      },
      {
        role: 'model',
        parts: [{ text: 'Olá! Em que posso te ajudar?' }],
      },
    ];
  }

  setCachedHistory(chatKey, history);
  return model.startChat({ history });
};

function trimHistory(history: ChatHistory): ChatHistory {
  // Limita por turnos e por tamanho aproximado de caracteres
  const byTurns =
    history.length > HISTORY_MAX_TURNS
      ? history.slice(history.length - HISTORY_MAX_TURNS)
      : history.slice();

  // percorre de trás pra frente até estourar budget
  const reversed = [...byTurns].reverse();
  const kept: ChatHistory = [];
  let totalChars = 0;

  for (const entry of reversed) {
    const entryText = entry.parts.map((p) => p.text || "").join(" ");
    const entryLen = entryText.length;
    if (kept.length && totalChars + entryLen > HISTORY_MAX_CHARS) {
      break;
    }
    kept.push(entry);
    totalChars += entryLen;
  }

  return kept.reverse();
}

const shouldCleanupHistory = (userId: number) => {
  const last = historyCleanupMarkers.get(userId) || 0;
  return Date.now() - last >= CHAT_HISTORY_CLEAN_INTERVAL_MS;
};

const maybeCleanupChatHistory = (userId: number) => {
  if (!shouldCleanupHistory(userId)) return;
  historyCleanupMarkers.set(userId, Date.now());
  cleanupChatHistory(userId).catch((err) => {
    console.warn("Não foi possível limpar chat_histories:", err);
  });
};

async function cleanupChatHistory(userId: number) {
  const db = getDB();

  // 1) Limpeza por tempo
  const cutoffSeconds = Math.floor((Date.now() - CHAT_HISTORY_RETENTION_MS) / 1000);
  await db.run(
    `DELETE FROM chat_histories WHERE user_id = ? AND UNIX_TIMESTAMP(updated_at) < ?`,
    [userId, cutoffSeconds]
  );

  // 2) Limpeza por volume (mantém os mais recentes)
  const countRow = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM chat_histories WHERE user_id = ?`,
    [userId]
  );
  const total = countRow?.total || 0;
  if (total <= CHAT_HISTORY_MAX_PER_USER) return;

  await db.run(
    `DELETE FROM chat_histories
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM chat_histories
           WHERE user_id = ?
           ORDER BY updated_at DESC
           LIMIT ?
         ) AS recent
       )`,
    [userId, userId, CHAT_HISTORY_MAX_PER_USER]
  );
}

// =======================================
// 🧠 Função principal da IA Gemini
// =======================================
export const mainGoogle = async ({
  currentMessage,
  chatId,
  userId,
  sessionName,
  promptUsuario,
  onStream,
}: {
  currentMessage: string;
  chatId: string;
  userId: number | string;
  sessionName: string;
  promptUsuario: string;
  onStream?: (delta: string) => Promise<void> | void;
}): Promise<string> => {
  const chatKey = buildChatKey(userId, sessionName, chatId);

  const shouldRetry = (err: any) => {
    const status = err?.status || err?.code || err?.response?.status;
    const msg = String(err?.message || "").toLowerCase();
    return (
      status === 503 ||
      status === 500 ||
      status === 429 ||
      msg.includes("high demand") ||
      msg.includes("service unavailable") ||
      msg.includes("temporarily unavailable")
    );
  };

  const computeBackoff = (attempt: number, status?: number) => {
    if (status === 429) {
      return GEMINI_429_BACKOFF[Math.max(0, Math.min(GEMINI_429_BACKOFF.length - 1, attempt - 1))];
    }
    // exponencial com jitter: base 1s * 2^(attempt-1), max 12s, random +/- 25%
    const base = Math.min(12_000, 1000 * Math.pow(2, attempt - 1));
    const jitter = base * 0.25;
    return base + (Math.random() * 2 - 1) * jitter;
  };

  try {
    const chat = await getOrCreateChatSession({
      chatKey,
      promptUsuario,
      userId: Number(userId),
      sessionName,
      chatId,
    });
    let attempts = 0;
    let lastErr: any = null;
    let text: string | null = null;

    while (attempts < 3 && text === null) {
      attempts++;
      try {
        const canStream = typeof (chat as any).sendMessageStream === "function";

        if (canStream && onStream) {
          let collected = "";
          const stream = await (chat as any).sendMessageStream(currentMessage);
          for await (const chunk of stream.stream) {
            const delta = chunk?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
            if (delta) {
              collected += delta;
              await onStream(delta);
            }
          }
          text = collected || "Sem resposta.";
        } else {
          const result = await chat.sendMessage(currentMessage);
          text = result.response?.text?.() || "Sem resposta.";
        }
      } catch (err: any) {
        lastErr = err;
        if (!shouldRetry(err) || attempts >= 3) break;
        const status = err?.status || err?.code || err?.response?.status;
        const delay = computeBackoff(attempts, status);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (text === null) {
      throw lastErr ?? new Error("Falha desconhecida na IA");
    }

    // Salvar histórico
    const history =
      getCachedHistory(chatKey) ||
      (await loadHistoryFromDB({ userId, sessionName, chatId })) ||
      [];
    history.push(
      { role: 'user', parts: [{ text: currentMessage }] },
      { role: 'model', parts: [{ text }] }
    );

    const trimmed = trimHistory(history);
    queuePersist({
      chatKey,
      userId: Number(userId),
      sessionName,
      chatId,
      history: trimmed,
    });

    console.log(`📩 Gemini Resposta (${chatKey}):`, text);
    return text;

  } catch (err: any) {
    console.error(`❌ Erro IA tentativa:`, err?.status, err?.message);

    // 🛑 Caso seja erro de cota -> resposta amigável
    if (err?.status === 429) {
      return "⚠️ A IA está temporariamente indisponível devido ao limite de uso. Tente novamente dentro de alguns minutos.";
    }

    // Alta demanda ou indisponibilidade temporária
    if (err?.status === 503 || String(err?.message || "").toLowerCase().includes("high demand")) {
      return "⚡ A IA está com alta demanda agora - tente novamente em alguns segundos";
    }

    return "❌ Ocorreu um erro inesperado ao tentar responder.";
  }
};

// =======================================
// 🛑 Nova função para encerrar o chat
// =======================================
export const stopChatSession = async (
  userId: number,
  sessionName: string,
  chatId: string
): Promise<void> => {
  const chatKey = buildChatKey(userId, sessionName, chatId);

  if (activeChats.has(chatKey)) {
    activeChats.delete(chatKey);
    console.log(`🔥 Chat encerrado -> ${chatKey}`);
  } else {
    console.log(`⚠️ Nenhuma sessão ativa encontrada para -> ${chatKey}`);
  }

  // garante que histórico pendente seja salvo antes de encerrar
  await flushPersist(chatKey);
};
