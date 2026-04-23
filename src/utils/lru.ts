import LRUCache from "lru-cache";

export { LRUCache };

export function readPositiveEnvInt(
  envKey: string,
  fallback: number,
  minimum = 1
) {
  const raw = Number(process.env[envKey] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(minimum, Math.trunc(raw));
}

export function createLRUCache<K, V>(
  envKey: string,
  fallback: number,
  options: Partial<LRUCache.Options<K, V>> = {}
) {
  return new LRUCache<K, V>({
    max: readPositiveEnvInt(envKey, fallback),
    ...options,
  });
}

export function clearTimerSafely(timer?: NodeJS.Timeout | null) {
  if (!timer) return;
  clearTimeout(timer);
}

export function describeLRUCache(cache: Pick<LRUCache<any, any>, "size" | "max">) {
  return {
    size: cache.size,
    max: cache.max,
  };
}
