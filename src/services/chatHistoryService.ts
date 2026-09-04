import { getDB, withDBTransaction } from "../database";
import {
  decodeCompressedJson,
  encodeCompressedJson,
} from "../utils/chatHistoryCodec";

export type PersistedChatHistoryEntry = {
  role: "user" | "model";
  parts: { text: string }[];
};

const CHAT_HISTORY_MAX_TURNS = 32;
const CHAT_HISTORY_MAX_CHARS = 12_000;

function normalizeHistoryText(text: string | null | undefined): string {
  const normalized = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return normalized;
}

function normalizeEntry(
  entry: PersistedChatHistoryEntry | null | undefined
): PersistedChatHistoryEntry | null {
  if (!entry || (entry.role !== "user" && entry.role !== "model")) {
    return null;
  }

  const text = normalizeHistoryText(
    Array.isArray(entry.parts)
      ? entry.parts.map((part) => String(part?.text || "")).join(" ")
      : ""
  );

  if (!text) return null;

  return {
    role: entry.role,
    parts: [{ text }],
  };
}

function trimHistory(
  history: PersistedChatHistoryEntry[]
): PersistedChatHistoryEntry[] {
  const byTurns =
    history.length > CHAT_HISTORY_MAX_TURNS
      ? history.slice(history.length - CHAT_HISTORY_MAX_TURNS)
      : history.slice();

  const reversed = [...byTurns].reverse();
  const kept: PersistedChatHistoryEntry[] = [];
  let totalChars = 0;

  for (const entry of reversed) {
    const entryText = normalizeHistoryText(
      entry.parts.map((part) => String(part?.text || "")).join(" ")
    );
    const entryLen = entryText.length;

    if (kept.length && totalChars + entryLen > CHAT_HISTORY_MAX_CHARS) {
      break;
    }

    kept.push({
      role: entry.role,
      parts: [{ text: entryText }],
    });
    totalChars += entryLen;
  }

  return kept.reverse();
}

async function readStoredHistory(
  userId: number,
  chatId: string
): Promise<PersistedChatHistoryEntry[]> {
  const db = getDB();
  const row = await db.get<{ history: Buffer | string | null }>(
    `SELECT history
     FROM chat_histories
     WHERE user_id = ? AND chat_id = ?
     LIMIT 1`,
    [userId, chatId]
  );

  if (!row?.history) return [];

  try {
    const decoded = await decodeCompressedJson<PersistedChatHistoryEntry[]>(
      row.history
    );
    if (!Array.isArray(decoded)) return [];

    return decoded
      .map((entry) => normalizeEntry(entry))
      .filter(Boolean) as PersistedChatHistoryEntry[];
  } catch (err) {
    console.warn("Nao foi possivel decodificar chat_histories:", err);
    return [];
  }
}

export async function loadRecentHistory(
  userId: number,
  chatId: string,
  limit = 10
): Promise<PersistedChatHistoryEntry[]> {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (!safeLimit) return [];

  const history = await readStoredHistory(userId, chatId);
  if (!history.length) return [];

  return history.slice(-safeLimit);
}

export function formatRecentHistoryForPrompt(
  entries: PersistedChatHistoryEntry[]
): string {
  if (!Array.isArray(entries) || !entries.length) return "";

  return entries
    .map((entry) => {
      const text = normalizeHistoryText(
        entry.parts.map((part) => String(part?.text || "")).join(" ")
      );
      if (!text) return null;
      const speaker = entry.role === "user" ? "Cliente" : "Bot";
      return `${speaker}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

export async function appendChatHistoryEntries(params: {
  userId: number;
  sessionName: string;
  chatId: string;
  entries: PersistedChatHistoryEntry[];
}): Promise<void> {
  const normalizedEntries = params.entries
    .map((entry) => normalizeEntry(entry))
    .filter(Boolean) as PersistedChatHistoryEntry[];

  if (!normalizedEntries.length) return;

  await withDBTransaction(async (db) => {
    const existingRow = await db.get<{ history: Buffer | string | null }>(
      `SELECT history
       FROM chat_histories
       WHERE user_id = ? AND chat_id = ?
       LIMIT 1
       FOR UPDATE`,
      [params.userId, params.chatId]
    );

    let history: PersistedChatHistoryEntry[] = [];
    if (existingRow?.history) {
      try {
        const decoded = await decodeCompressedJson<PersistedChatHistoryEntry[]>(
          existingRow.history
        );
        if (Array.isArray(decoded)) {
          history = decoded
            .map((entry) => normalizeEntry(entry))
            .filter(Boolean) as PersistedChatHistoryEntry[];
        }
      } catch (err) {
        console.warn("Nao foi possivel ler historico existente para append:", err);
      }
    }

    const mergedHistory = trimHistory([...history, ...normalizedEntries]);
    const compressedHistory = await encodeCompressedJson(mergedHistory);

    await db.run(
      `
      INSERT INTO chat_histories (user_id, session_name, chat_id, history)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        history = VALUES(history),
        session_name = VALUES(session_name),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        params.userId,
        params.sessionName || null,
        params.chatId,
        compressedHistory,
      ]
    );
  });
}

export async function clearChatHistory(
  userId: number,
  chatId: string
): Promise<void> {
  const db = getDB();
  await db.run(
    `DELETE FROM chat_histories
     WHERE user_id = ? AND chat_id = ?
     LIMIT 1`,
    [userId, chatId]
  );
}
