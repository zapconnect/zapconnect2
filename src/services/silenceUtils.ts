import { getDB } from "../database";
import { createLRUCache } from "../utils/lru";

type SilenceConfigRow = {
  ia_silence_start: number | null;
  ia_silence_end: number | null;
  timezone_offset: number | null;
};

const SILENCE_CONFIG_CACHE_TTL_MS = 60_000;
const silenceConfigCache = createLRUCache<number, SilenceConfigRow | null>(
  "AI_SILENCE_CONFIG_CACHE_MAX",
  5_000,
  { ttl: SILENCE_CONFIG_CACHE_TTL_MS }
);

export function clearSilenceConfigCache(userId?: number): void {
  if (typeof userId === "number") {
    silenceConfigCache.delete(userId);
    return;
  }
  silenceConfigCache.clear();
}

/**
 * Retorna true se o usuário configurou horário de silêncio e se a hora local atual (considerando timezone_offset)
 * está dentro do intervalo [start, end). Aceita faixas que cruzam meia-noite.
 */
export async function isInSilenceWindow(userId: number): Promise<boolean> {
  let row = silenceConfigCache.get(userId);
  if (row === undefined) {
    const db = getDB();
    row =
      (await db.get<SilenceConfigRow>(
        `SELECT ia_silence_start, ia_silence_end, timezone_offset FROM users WHERE id = ?`,
        [userId]
      )) || null;
    silenceConfigCache.set(userId, row);
  }

  if (!row || row.ia_silence_start === null || row.ia_silence_end === null) {
    return false;
  }

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
