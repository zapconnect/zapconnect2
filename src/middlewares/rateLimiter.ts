// src/middlewares/rateLimiter.ts
// ===============================
// 🔐 RATE LIMIT PERSISTENTE — compatível com múltiplas instâncias
// ===============================
// Armazena contadores em MySQL (tabela rate_limits) para sobreviver a restarts
// e balanceamento entre réplicas. Fallback para memória se o banco falhar.

import { getDB } from "../database";

interface AttemptRecord {
  count: number;
  firstAttempt: number;
  blockedUntil?: number | null;
}

// Fallback em memória (caso banco falhe momentaneamente)
const memoryStore = new Map<string, AttemptRecord>();

interface RateLimitOptions {
  windowMs: number;
  maxAttempts: number;
  blockDurationMs?: number;
  message?: string;
  prefix?: string;
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

function getIp(req: any): string {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export function createRateLimiter(opts: RateLimitOptions) {
  const {
    windowMs,
    maxAttempts,
    blockDurationMs = windowMs,
    message = "Muitas tentativas. Tente novamente mais tarde.",
    prefix = "rl",
  } = opts;

  return async function rateLimitMiddleware(
    req: any,
    res: any,
    next: any
  ) {
    const ip = getIp(req);
    const key = `${prefix}:${ip}`;
    const now = Date.now();

    let record: AttemptRecord | null = null;
    let dbOk = true;

    try {
      record = await getRecordDb(key);
    } catch (err) {
      dbOk = false;
      record = memoryStore.get(key) || null;
      console.warn("RateLimiter: falha ao ler do banco, usando memória:", err);
    }

    if (!record) {
      record = { count: 1, firstAttempt: now };
      if (dbOk) {
        try { await saveRecordDb(key, record); } catch { dbOk = false; }
      }
      if (!dbOk) memoryStore.set(key, record);
      res.setHeader("X-RateLimit-Limit", String(maxAttempts));
      res.setHeader("X-RateLimit-Remaining", String(maxAttempts - 1));
      return next();
    }

    // Bloqueado?
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

    // Janela expirou?
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

    // Persistir
    if (dbOk) {
      try {
        await saveRecordDb(key, record);
      } catch (err) {
        dbOk = false;
        console.warn("RateLimiter: falha ao salvar no banco, caindo para memória:", err);
      }
    }
    if (!dbOk) memoryStore.set(key, record);

    // Headers
    const remaining =
      record.count > maxAttempts ? 0 : Math.max(0, maxAttempts - record.count);
    res.setHeader("X-RateLimit-Limit", String(maxAttempts));
    res.setHeader("X-RateLimit-Remaining", String(remaining));

    // Bloqueado recém-atingido
    if (record.blockedUntil && now >= record.firstAttempt && record.count > maxAttempts) {
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

// ===============================
// 🎯 LIMITADORES PRÉ-CONFIGURADOS
// ===============================

/** Login: 10 tentativas em 15 min, bloqueio de 15 min */
export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  blockDurationMs: 15 * 60 * 1000,
  message: "Muitas tentativas de login. Aguarde 15 minutos e tente novamente.",
  prefix: "login",
});

/** Registro: 5 contas em 1 hora por IP */
export const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxAttempts: 5,
  blockDurationMs: 60 * 60 * 1000,
  message: "Muitas contas criadas. Aguarde 1 hora e tente novamente.",
  prefix: "register",
});

/** Esqueci a senha: 5 pedidos em 15 min */
export const forgotPasswordLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  blockDurationMs: 15 * 60 * 1000,
  message: "Muitos pedidos de recuperação. Aguarde 15 minutos.",
  prefix: "forgot",
});

/** Reenvio de e-mail: 3 tentativas em 10 min */
export const resendEmailLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxAttempts: 3,
  blockDurationMs: 10 * 60 * 1000,
  message: "Muitos reenvios. Aguarde 10 minutos.",
  prefix: "resend",
});
