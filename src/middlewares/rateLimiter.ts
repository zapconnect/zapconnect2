import { getDB } from "../database";

interface AttemptRecord {
  count: number;
  firstAttempt: number;
  blockedUntil?: number | null;
}

interface CachedAttemptRecord {
  record: AttemptRecord;
  expiresAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  maxAttempts: number;
  blockDurationMs?: number;
  message?: string;
  prefix?: string;
  keyBuilder?: (req: any) => string | null | undefined | Promise<string | null | undefined>;
  persistMode?: "async" | "sync";
}

const RATE_LIMIT_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.RATE_LIMIT_CACHE_TTL_MS || 15 * 60 * 1000)
);
const RATE_LIMIT_CACHE_SWEEP_MS = Math.max(
  60_000,
  Number(process.env.RATE_LIMIT_CACHE_SWEEP_MS || 2 * 60 * 1000)
);
const RATE_LIMIT_DB_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.RATE_LIMIT_DB_RETENTION_MS || 24 * 60 * 60 * 1000)
);
const RATE_LIMIT_DB_CLEANUP_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.RATE_LIMIT_DB_CLEANUP_INTERVAL_MS || 60 * 60 * 1000)
);
const DISPARO_MIN_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.DISPARO_MIN_INTERVAL_MS || 1_500)
);

const memoryStore = new Map<string, CachedAttemptRecord>();
const pendingDbWrites = new Map<string, Promise<void>>();
let maintenanceStarted = false;

function cloneRecord(record: AttemptRecord | null | undefined): AttemptRecord | null {
  if (!record) return null;
  return {
    count: Number(record.count || 0),
    firstAttempt: Number(record.firstAttempt || 0),
    blockedUntil: record.blockedUntil ? Number(record.blockedUntil) : null,
  };
}

function getCacheTtlMs(record: AttemptRecord, windowMs: number, now = Date.now()) {
  const blockedTtl = record.blockedUntil && record.blockedUntil > now
    ? record.blockedUntil - now
    : 0;
  const windowTtl = record.firstAttempt
    ? Math.max(0, windowMs - (now - record.firstAttempt))
    : windowMs;

  return Math.max(
    60_000,
    blockedTtl,
    Math.min(RATE_LIMIT_CACHE_TTL_MS, windowTtl || RATE_LIMIT_CACHE_TTL_MS)
  );
}

function getCachedRecord(key: string, now = Date.now()): AttemptRecord | null {
  const cached = memoryStore.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    memoryStore.delete(key);
    return null;
  }
  return cloneRecord(cached.record);
}

function cacheRecord(key: string, record: AttemptRecord, windowMs: number, now = Date.now()) {
  const snapshot = cloneRecord(record);
  if (!snapshot) return;
  memoryStore.set(key, {
    record: snapshot,
    expiresAt: now + getCacheTtlMs(snapshot, windowMs, now),
  });
}

async function getRecordDb(key: string): Promise<AttemptRecord | null> {
  const db = getDB();
  const row = await db.get<{
    count: number;
    first_attempt: number;
    blocked_until: number | null;
  }>(
    `SELECT count, first_attempt, blocked_until FROM rate_limits WHERE rate_key = ?`,
    [key]
  );

  if (!row) return null;

  return {
    count: Number(row.count || 0),
    firstAttempt: Number(row.first_attempt || 0),
    blockedUntil: row.blocked_until ? Number(row.blocked_until) : null,
  };
}

async function saveRecordDb(key: string, record: AttemptRecord) {
  const db = getDB();
  await db.run(
    `
    INSERT INTO rate_limits (rate_key, count, first_attempt, blocked_until)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      count = VALUES(count),
      first_attempt = VALUES(first_attempt),
      blocked_until = VALUES(blocked_until)
    `,
    [key, record.count, record.firstAttempt, record.blockedUntil ?? null]
  );
}

async function cleanupRateLimitTable() {
  try {
    const db = getDB();
    const now = Date.now();
    const staleBefore = now - RATE_LIMIT_DB_RETENTION_MS;
    await db.run(
      `
      DELETE FROM rate_limits
      WHERE (blocked_until IS NULL OR blocked_until < ?)
        AND first_attempt < ?
      `,
      [now, staleBefore]
    );
  } catch (err) {
    console.warn("RateLimiter: falha ao limpar tabela rate_limits:", err);
  }
}

function cleanupRateLimitCache() {
  const now = Date.now();
  for (const [key, cached] of memoryStore.entries()) {
    if (cached.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }
}

function startRateLimitMaintenance() {
  if (maintenanceStarted) return;
  maintenanceStarted = true;

  const cacheTimer = setInterval(cleanupRateLimitCache, RATE_LIMIT_CACHE_SWEEP_MS);
  cacheTimer.unref();

  const dbTimer = setInterval(() => {
    void cleanupRateLimitTable();
  }, RATE_LIMIT_DB_CLEANUP_INTERVAL_MS);
  dbTimer.unref();
}

function queueRecordPersist(key: string, record: AttemptRecord, windowMs: number) {
  const snapshot = cloneRecord(record);
  if (!snapshot) return Promise.resolve();

  cacheRecord(key, snapshot, windowMs);

  const previous = pendingDbWrites.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        await saveRecordDb(key, snapshot);
      } catch (err) {
        console.warn("RateLimiter: falha ao salvar no banco, mantendo cache em memoria:", err);
        cacheRecord(key, snapshot, windowMs);
      }
    })
    .finally(() => {
      if (pendingDbWrites.get(key) === next) {
        pendingDbWrites.delete(key);
      }
    });

  pendingDbWrites.set(key, next);
  return next;
}

async function persistRecord(
  key: string,
  record: AttemptRecord,
  windowMs: number,
  mode: "async" | "sync"
) {
  const persistPromise = queueRecordPersist(key, record, windowMs);
  if (mode === "sync") {
    await persistPromise;
  }
}

async function loadRecord(key: string, windowMs: number): Promise<AttemptRecord | null> {
  const cached = getCachedRecord(key);
  if (cached) return cached;

  try {
    const dbRecord = await getRecordDb(key);
    if (dbRecord) {
      cacheRecord(key, dbRecord, windowMs);
    }
    return dbRecord;
  } catch (err) {
    console.warn("RateLimiter: falha ao ler do banco, usando cache local:", err);
    return getCachedRecord(key);
  }
}

function getIp(req: any): string {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

startRateLimitMaintenance();

export function createRateLimiter(opts: RateLimitOptions) {
  const {
    windowMs,
    maxAttempts,
    blockDurationMs = windowMs,
    message = "Muitas tentativas. Tente novamente mais tarde.",
    prefix = "rl",
    keyBuilder,
    persistMode = "async",
  } = opts;

  return async function rateLimitMiddleware(
    req: any,
    res: any,
    next: any
  ) {
    const builtKey = keyBuilder ? await keyBuilder(req) : null;
    const identity = String(builtKey || getIp(req) || "unknown").trim() || "unknown";
    const key = `${prefix}:${identity}`;
    const now = Date.now();

    let record = await loadRecord(key, windowMs);

    if (!record) {
      record = { count: 1, firstAttempt: now, blockedUntil: null };
      await persistRecord(key, record, windowMs, persistMode);
      res.setHeader("X-RateLimit-Limit", String(maxAttempts));
      res.setHeader("X-RateLimit-Remaining", String(maxAttempts - 1));
      return next();
    }

    cacheRecord(key, record, windowMs, now);

    if (record.blockedUntil && now < record.blockedUntil) {
      const remainingSecs = Math.ceil((record.blockedUntil - now) / 1000);
      const remainingMins = Math.ceil(remainingSecs / 60);

      res.setHeader("Retry-After", String(remainingSecs));
      res.setHeader("X-RateLimit-Limit", String(maxAttempts));
      res.setHeader("X-RateLimit-Remaining", "0");

      return res.status(429).json({
        error: message,
        retryAfter: remainingSecs,
        retryAfterMinutes: remainingMins,
      });
    }

    if (now - record.firstAttempt > windowMs) {
      record.count = 1;
      record.firstAttempt = now;
      record.blockedUntil = null;
    } else {
      record.count += 1;
      if (record.count > maxAttempts) {
        record.blockedUntil = now + blockDurationMs;
      }
    }

    await persistRecord(key, record, windowMs, persistMode);

    const remaining =
      record.count > maxAttempts ? 0 : Math.max(0, maxAttempts - record.count);
    res.setHeader("X-RateLimit-Limit", String(maxAttempts));
    res.setHeader("X-RateLimit-Remaining", String(remaining));

    if (record.blockedUntil && record.count > maxAttempts) {
      const remainingSecs = Math.ceil((record.blockedUntil - now) / 1000);
      const remainingMins = Math.ceil(remainingSecs / 60);
      res.setHeader("Retry-After", String(remainingSecs));
      return res.status(429).json({
        error: message,
        retryAfter: remainingSecs,
        retryAfterMinutes: remainingMins,
      });
    }

    return next();
  };
}

export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  blockDurationMs: 15 * 60 * 1000,
  message: "Muitas tentativas de login. Aguarde 15 minutos e tente novamente.",
  prefix: "login",
});

export const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxAttempts: 5,
  blockDurationMs: 60 * 60 * 1000,
  message: "Muitas contas criadas. Aguarde 1 hora e tente novamente.",
  prefix: "register",
});

export const forgotPasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  blockDurationMs: 15 * 60 * 1000,
  message: "Muitos pedidos de recuperacao. Aguarde 15 minutos.",
  prefix: "forgot",
});

export const resendEmailLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 3,
  blockDurationMs: 10 * 60 * 1000,
  message: "Muitos reenvios. Aguarde 10 minutos.",
  prefix: "resend",
});

export const disparoUserLimiter = createRateLimiter({
  windowMs: DISPARO_MIN_INTERVAL_MS,
  maxAttempts: 1,
  blockDurationMs: DISPARO_MIN_INTERVAL_MS,
  message: "Aguarde antes de iniciar outro disparo.",
  prefix: "disparo_user",
  persistMode: "sync",
  keyBuilder: async (req: any) => {
    const userId = Number(req?.user?.id);
    return Number.isFinite(userId) && userId > 0 ? String(userId) : null;
  },
});
