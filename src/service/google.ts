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

const activeChats = new Map<string, ChatHistory>();
const HISTORY_MAX_TURNS = 32; // user+model entries
const HISTORY_MAX_CHARS = 12000; // heurística simples (~3k tokens)

// =======================================
// 🔑 Create Key: user + session + chat ID
// =======================================
const normalizeUserId = (userId: number | string) => String(userId).trim();

const buildChatKey = (
  userId: number | string,
  sessionName: string,
  chatId: string
) => `USER${normalizeUserId(userId)}_${sessionName}::${chatId}`;

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
  if (activeChats.has(chatKey)) {
    return model.startChat({ history: activeChats.get(chatKey)! });
  }

  let history: ChatHistory | null = await loadHistoryFromDB({
    userId,
    sessionName,
    chatId,
  });

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

  activeChats.set(chatKey, history);
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
      msg.includes("service unavailable")
    );
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
        const delay =
          status === 429
            ? GEMINI_429_BACKOFF[Math.max(0, Math.min(GEMINI_429_BACKOFF.length - 1, attempts - 1))]
            : attempts === 1
              ? 1200
              : 2500;
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (text === null) {
      throw lastErr ?? new Error("Falha desconhecida na IA");
    }

    // Salvar histórico
    const history = activeChats.get(chatKey) || [];
    history.push(
      { role: 'user', parts: [{ text: currentMessage }] },
      { role: 'model', parts: [{ text }] }
    );

    const trimmed = trimHistory(history);
    activeChats.set(chatKey, trimmed);
    await persistHistory({ userId: Number(userId), sessionName, chatId, history: trimmed });

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
export const stopChatSession = (
  userId: number,
  sessionName: string,
  chatId: string
): void => {
  const chatKey = buildChatKey(userId, sessionName, chatId);

  if (activeChats.has(chatKey)) {
    activeChats.delete(chatKey);
    console.log(`🔥 Chat encerrado -> ${chatKey}`);
  } else {
    console.log(`⚠️ Nenhuma sessão ativa encontrada para -> ${chatKey}`);
  }
};
