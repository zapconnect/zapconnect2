// src/services/chatAiService.ts
import { getDB } from "../database";

export async function getChatAI(
  userId: number,
  chatId: string
): Promise<boolean> {
  const db = getDB();

  const row = await db.get<{ ai_enabled: number }>(
    `SELECT ai_enabled
     FROM chat_ai_settings
     WHERE user_id = ? AND chat_id = ?`,
    [userId, chatId]
  );

  // 🔘 Default = ligado
  if (!row) return true;

  return row.ai_enabled === 1;
}

export async function setChatAI(
  userId: number,
  chatId: string,
  enabled: boolean
): Promise<void> {
  const db = getDB();

  await db.run(
    `
    INSERT INTO chat_ai_settings (user_id, chat_id, ai_enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      ai_enabled = VALUES(ai_enabled),
      updated_at = VALUES(updated_at)
    `,
    [userId, chatId, enabled ? 1 : 0, Date.now()]
  );
}