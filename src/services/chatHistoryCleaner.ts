import { getDB } from "../database";

const HISTORY_RETENTION_DAYS = 90; // mantém histórico dos últimos 90 dias
const HISTORY_MAX_PER_USER = 500;  // máximo de chats distintos por usuário

export async function runChatHistoryCleanup(): Promise<void> {
  const db = getDB();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - HISTORY_RETENTION_DAYS);

  try {
    // 1) Remove históricos antigos
    const byAge = await db.run(
      `DELETE FROM chat_histories
       WHERE updated_at < ?`,
      [cutoff.toISOString().slice(0, 19).replace("T", " ")]
    );

    // 2) Por usuário, mantém somente os 500 mais recentes
    const overLimit = await db.all<{ user_id: number; total: number }>(
      `SELECT user_id, COUNT(*) as total
       FROM chat_histories
       GROUP BY user_id
       HAVING total > ?`,
      [HISTORY_MAX_PER_USER]
    );

    let deletedByVolume = 0;
    for (const row of overLimit) {
      const toDelete = await db.all<{ id: number }>(
        `SELECT id FROM chat_histories
         WHERE user_id = ?
         ORDER BY updated_at ASC
         LIMIT ?`,
        [row.user_id, row.total - HISTORY_MAX_PER_USER]
      );

      if (!toDelete.length) continue;

      const placeholders = toDelete.map(() => "?").join(",");
      const ids = toDelete.map((r) => r.id);
      await db.run(
        `DELETE FROM chat_histories WHERE id IN (${placeholders})`,
        ids
      );
      deletedByVolume += ids.length;
    }

    if ((byAge as any)?.affectedRows || deletedByVolume) {
      console.log(
        `🧹 chat_histories: ${(byAge as any)?.affectedRows || 0} por tempo, ${deletedByVolume} por volume`
      );
    }
  } catch (err) {
    console.error("Erro na limpeza de chat_histories:", err);
  }
}
