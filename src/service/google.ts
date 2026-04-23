import { GoogleGenerativeAI, type ChatSession } from "@google/generative-ai";
import dotenv from "dotenv";
import { getDB, withDBTransaction } from "../database";
import {
  decodeCompressedJson,
  encodeCompressedJson,
} from "../utils/chatHistoryCodec";
import { withTimeout } from "../utils/withTimeout";
import {
  createLRUCache,
  clearTimerSafely,
  describeLRUCache,
} from "../utils/lru";

dotenv.config();

const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY!);
const GEMINI_429_BACKOFF = [10_000, 30_000, 60_000];
const GEMINI_RESPONSE_TIMEOUT_MS = Number(
  process.env.GEMINI_RESPONSE_TIMEOUT_MS || 25_000
);

type ChatHistory = {
  role: "user" | "model";
  parts: { text: string }[];
}[];

type CachedHistory = { history: ChatHistory; expiresAt: number };

const CHAT_CACHE_TTL_MS = 30 * 60 * 1000;
const activeChats = createLRUCache<string, CachedHistory>(
  "GOOGLE_ACTIVE_CHAT_CACHE_MAX",
  5_000,
  { ttl: CHAT_CACHE_TTL_MS }
);
const PERSIST_DEBOUNCE_MS = 3000;
const PERSIST_FORCE_EVERY = 10;
const CHAT_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CHAT_HISTORY_MAX_PER_USER = 500;
const CHAT_HISTORY_CLEAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

type PersistState = {
  timer?: NodeJS.Timeout;
  pendingCount: number;
  lastHistory: ChatHistory;
  userId: number | string;
  sessionName: string;
  chatId: string;
};

type GeminiStreamTimeoutError = Error & {
  code: "gemini_stream_timeout";
  collected: string;
};

const persistQueue = createLRUCache<string, PersistState>(
  "GOOGLE_PERSIST_QUEUE_MAX",
  5_000,
  {
    dispose: (state) => clearTimerSafely(state?.timer),
  }
);
const HISTORY_MAX_TURNS = 32;
const HISTORY_MAX_CHARS = 12000;
const historyCleanupMarkers = createLRUCache<number, number>(
  "GOOGLE_HISTORY_CLEANUP_CACHE_MAX",
  10_000,
  { ttl: CHAT_HISTORY_CLEAN_INTERVAL_MS }
);
const historyCleanupInFlight = new Map<number, Promise<void>>();

const normalizeUserId = (userId: number | string) => String(userId).trim();

const buildChatKey = (
  userId: number | string,
  chatId: string
) => `USER${normalizeUserId(userId)}::${chatId}`;

const extractGeminiDelta = (chunk: any) =>
  chunk?.candidates?.[0]?.content?.parts
    ?.map((p: any) => p?.text ?? "")
    .join("") ?? "";

const isGeminiStreamTimeoutError = (
  err: unknown
): err is GeminiStreamTimeoutError =>
  !!err &&
  typeof err === "object" &&
  (err as GeminiStreamTimeoutError).code === "gemini_stream_timeout";

const closeGeminiStreamQuietly = (streamResult: any) => {
  try {
    const returnFn = streamResult?.stream?.return;
    if (typeof returnFn !== "function") return;
    const maybePromise = returnFn.call(streamResult.stream);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {}
};

function buildGeminiTimeoutFallback(collected: string) {
  const trimmed = String(collected || "").trim();
  if (trimmed.length >= 50) {
    return `${trimmed}\n\n(Resposta interrompida por demora da IA.)`;
  }
  return "A IA demorou muito para responder. Tente novamente.";
}

async function streamGeminiWithTimeout({
  chat,
  currentMessage,
  onStream,
  timeoutMs = GEMINI_RESPONSE_TIMEOUT_MS,
}: {
  chat: ChatSession;
  currentMessage: string;
  onStream: (delta: string) => Promise<void> | void;
  timeoutMs?: number;
}) {
  let collected = "";
  let streamResult: any = null;
  let timer: NodeJS.Timeout | undefined;

  const streamPromise = (async () => {
    streamResult = await (chat as any).sendMessageStream(currentMessage);

    for await (const chunk of streamResult.stream) {
      const delta = extractGeminiDelta(chunk);
      if (!delta) continue;
      collected += delta;
      await onStream(delta);
    }

    return collected;
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      closeGeminiStreamQuietly(streamResult);
      const timeoutError = new Error(
        `Timeout do stream Gemini apos ${timeoutMs}ms`
      ) as GeminiStreamTimeoutError;
      timeoutError.code = "gemini_stream_timeout";
      timeoutError.collected = collected;
      reject(timeoutError);
    }, timeoutMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  try {
    return await Promise.race([streamPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getGeminiModel(systemInstruction?: string | null) {
  return genAI.getGenerativeModel(
    systemInstruction?.trim()
      ? { model: MODEL_ID, systemInstruction }
      : { model: MODEL_ID }
  );
}

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

const getCachedOrStoredHistory = async ({
  chatKey,
  userId,
  chatId,
}: {
  chatKey: string;
  userId: number | string;
  chatId: string;
}): Promise<ChatHistory | null> => {
  const cached = getCachedHistory(chatKey);
  if (cached?.length) return cached;

  const stored = await loadHistoryFromDB({ userId, chatId });
  if (stored?.length) {
    setCachedHistory(chatKey, stored);
    return stored;
  }

  return null;
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
      console.warn("Falha ao persistir historico (debounce):", err)
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
      console.warn("Falha ao persistir historico (forcado):", err)
    );
  }
};

async function loadHistoryFromDB({
  userId,
  chatId,
}: {
  userId: number | string;
  chatId: string;
}): Promise<ChatHistory | null> {
  try {
    const numericUserId = Number(userId);
    const db = getDB();
    const row = await db.get<{ history: Buffer | string | null }>(
      `SELECT history
       FROM chat_histories
       WHERE user_id = ? AND chat_id = ?
       LIMIT 1`,
      [numericUserId, chatId]
    );
    if (!row?.history) return null;
    const parsed = await decodeCompressedJson<unknown>(row.history);
    if (!Array.isArray(parsed)) return null;
    return parsed as ChatHistory;
  } catch (err) {
    console.warn("Nao foi possivel carregar historico do banco:", err);
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
    const compressedHistory = await encodeCompressedJson(trimmed);
    await db.run(
      `
      INSERT INTO chat_histories (user_id, session_name, chat_id, history)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        history = VALUES(history),
        session_name = VALUES(session_name),
        updated_at = CURRENT_TIMESTAMP
      `,
      [numericUserId, sessionName, chatId, compressedHistory]
    );

    maybeCleanupChatHistory(numericUserId);
  } catch (err) {
    console.warn("Nao foi possivel salvar historico no banco:", err);
  }
}

const getOrCreateChatSession = async ({
  chatKey,
  systemInstruction,
  userId,
  chatId,
}: {
  chatKey: string;
  systemInstruction?: string | null;
  userId: number;
  chatId: string;
}): Promise<ChatSession> => {
  let history = await getCachedOrStoredHistory({
    chatKey,
    userId,
    chatId,
  });

  if (!history || !history.length) {
    history = [];
  }

  setCachedHistory(chatKey, history);
  return getGeminiModel(systemInstruction).startChat({ history });
};

function trimHistory(history: ChatHistory): ChatHistory {
  const byTurns =
    history.length > HISTORY_MAX_TURNS
      ? history.slice(history.length - HISTORY_MAX_TURNS)
      : history.slice();

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
  if (historyCleanupInFlight.has(userId)) return;

  const job = cleanupChatHistory(userId)
    .catch((err) => {
      console.warn("Nao foi possivel limpar chat_histories:", err);
    })
    .finally(() => {
      historyCleanupInFlight.delete(userId);
    });

  historyCleanupInFlight.set(userId, job);
};

async function cleanupChatHistory(userId: number) {
  const now = Date.now();
  const cleanedAt = await withDBTransaction<number | null>(async (db) => {
    const userRow = await db.get<{ chat_history_cleaned_at: number | null }>(
      `SELECT chat_history_cleaned_at
       FROM users
       WHERE id = ?
       FOR UPDATE`,
      [userId]
    );
    if (!userRow) return null;

    const lastCleanupAt = Number(userRow.chat_history_cleaned_at || 0) || 0;
    if (lastCleanupAt && now - lastCleanupAt < CHAT_HISTORY_CLEAN_INTERVAL_MS) {
      return lastCleanupAt;
    }

    const cutoffSeconds = Math.floor((now - CHAT_HISTORY_RETENTION_MS) / 1000);
    await db.run(
      `DELETE FROM chat_histories WHERE user_id = ? AND UNIX_TIMESTAMP(updated_at) < ?`,
      [userId, cutoffSeconds]
    );

    const countRow = await db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM chat_histories WHERE user_id = ?`,
      [userId]
    );
    const total = countRow?.total || 0;

    if (total > CHAT_HISTORY_MAX_PER_USER) {
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

    await db.run(
      `UPDATE users
       SET chat_history_cleaned_at = ?
       WHERE id = ?`,
      [now, userId]
    );
    return now;
  });

  if (cleanedAt) {
    historyCleanupMarkers.set(userId, cleanedAt);
  }
}

export const mainGoogle = async ({
  currentMessage,
  userMessage,
  systemInstruction,
  chatId,
  userId,
  sessionName,
  onStream,
}: {
  currentMessage: string;
  userMessage?: string;
  systemInstruction?: string | null;
  chatId: string;
  userId: number | string;
  sessionName: string;
  onStream?: (delta: string) => Promise<void> | void;
}): Promise<string> => {
  const chatKey = buildChatKey(userId, chatId);

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
      return GEMINI_429_BACKOFF[
        Math.max(0, Math.min(GEMINI_429_BACKOFF.length - 1, attempt - 1))
      ];
    }
    const base = Math.min(12_000, 1000 * Math.pow(2, attempt - 1));
    const jitter = base * 0.25;
    return base + (Math.random() * 2 - 1) * jitter;
  };

  try {
    const chat = await getOrCreateChatSession({
      chatKey,
      systemInstruction,
      userId: Number(userId),
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
          try {
            text =
              (await streamGeminiWithTimeout({
                chat,
                currentMessage,
                onStream,
              })) || "Sem resposta.";
          } catch (streamErr) {
            if (!isGeminiStreamTimeoutError(streamErr)) {
              throw streamErr;
            }
            console.warn(`Gemini stream timeout (${chatKey})`);
            text = buildGeminiTimeoutFallback(streamErr.collected);
          }
        } else {
          const result = await withTimeout(
            chat.sendMessage(currentMessage),
            GEMINI_RESPONSE_TIMEOUT_MS,
            "Gemini sendMessage"
          );
          text = result.response?.text?.() || "Sem resposta.";
        }
      } catch (err: any) {
        lastErr = err;
        if (!shouldRetry(err) || attempts >= 3) break;
        const status = err?.status || err?.code || err?.response?.status;
        const delay = computeBackoff(attempts, status);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (text === null) {
      throw lastErr ?? new Error("Falha desconhecida na IA");
    }

    const history =
      (await getCachedOrStoredHistory({ chatKey, userId, chatId })) ||
      [];
    history.push(
      { role: "user", parts: [{ text: userMessage || currentMessage }] },
      { role: "model", parts: [{ text }] }
    );

    queuePersist({
      chatKey,
      userId: Number(userId),
      sessionName,
      chatId,
      history,
    });

    console.log(`Gemini resposta (${chatKey}):`, text);
    return text;
  } catch (err: any) {
    console.error("Erro IA tentativa:", err?.status, err?.message);

    if (
      isGeminiStreamTimeoutError(err) ||
      String(err?.message || "").toLowerCase().includes("timeout")
    ) {
      return buildGeminiTimeoutFallback(
        isGeminiStreamTimeoutError(err) ? err.collected : ""
      );
    }

    if (err?.status === 429) {
      return "A IA esta temporariamente indisponivel devido ao limite de uso. Tente novamente dentro de alguns minutos.";
    }

    if (err?.status === 503 || String(err?.message || "").toLowerCase().includes("high demand")) {
      return "A IA esta com alta demanda agora. Tente novamente em alguns segundos.";
    }

    return "Ocorreu um erro inesperado ao tentar responder.";
  }
};

export function getGoogleRuntimeCacheStats() {
  return {
    activeChats: describeLRUCache(activeChats),
    persistQueue: describeLRUCache(persistQueue),
    historyCleanupMarkers: describeLRUCache(historyCleanupMarkers),
    historyCleanupInFlight: historyCleanupInFlight.size,
  };
}

export const stopChatSession = async (
  userId: number,
  sessionName: string,
  chatId: string
): Promise<void> => {
  void sessionName;
  const chatKey = buildChatKey(userId, chatId);

  if (activeChats.has(chatKey)) {
    activeChats.delete(chatKey);
    console.log(`Chat encerrado -> ${chatKey}`);
  } else {
    console.log(`Nenhuma sessao ativa encontrada para -> ${chatKey}`);
  }

  await flushPersist(chatKey);
};
