import { getDB } from "../database";

/**
 * Retorna true se o usuário configurou horário de silêncio e se a hora local atual (considerando timezone_offset)
 * está dentro do intervalo [start, end). Aceita faixas que cruzam meia-noite.
 */
export async function isInSilenceWindow(userId: number): Promise<boolean> {
  const db = getDB();
  const row = await db.get<{
    ia_silence_start: number | null;
    ia_silence_end: number | null;
    timezone_offset: number | null;
  }>(
    `SELECT ia_silence_start, ia_silence_end, timezone_offset FROM users WHERE id = ?`,
    [userId]
  );

  if (row?.ia_silence_start === null || row?.ia_silence_end === null) return false;

  const offsetMinutes = Number.isFinite(row.timezone_offset)
    ? Number(row.timezone_offset)
    : 0;

  const localMs = Date.now() + offsetMinutes * 60_000;
  const nowHour = new Date(localMs).getUTCHours(); // hora local considerando offset
  const s = Number(row.ia_silence_start);
  const e = Number(row.ia_silence_end);

  const inSilence =
    s <= e
      ? nowHour >= s && nowHour < e // ex: 9–17
      : nowHour >= s || nowHour < e; // ex: 22–8

  return inSilence;
}
