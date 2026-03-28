// src/middlewares/rateLimiter.ts
// ===============================
// 🛡️ RATE LIMITING — PROTEÇÃO CONTRA BRUTE FORCE
// ===============================
// Implementação sem dependências externas (puro Node.js)
// Funciona em memória — reinicia com o servidor
// Para produção com múltiplas instâncias, considere Redis

interface AttemptRecord {
  count: number;
  firstAttempt: number;
  blockedUntil?: number;
}

const store = new Map<string, AttemptRecord>();

// 🧹 Limpeza automática a cada 10 minutos (evita vazamento de memória)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    const isExpired =
      record.blockedUntil
        ? now > record.blockedUntil + 60_000   // 1 min após desbloquear
        : now - record.firstAttempt > 15 * 60_000; // 15 min sem tentativa

    if (isExpired) store.delete(key);
  }
}, 10 * 60_000);

// ===============================
// 🏭 FACTORY DE LIMITADORES
// ===============================
interface RateLimitOptions {
  /** Janela de tempo em ms (ex: 15 * 60 * 1000 = 15 min) */
  windowMs: number;
  /** Máximo de tentativas na janela */
  maxAttempts: number;
  /** Tempo de bloqueio após exceder (ms). Default: windowMs */
  blockDurationMs?: number;
  /** Mensagem de erro retornada */
  message?: string;
  /** Prefixo para separar stores por rota */
  prefix?: string;
}

export function createRateLimiter(opts: RateLimitOptions) {
  const {
    windowMs,
    maxAttempts,
    blockDurationMs = windowMs,
    message = "Muitas tentativas. Tente novamente mais tarde.",
    prefix = "rl",
  } = opts;

  return function rateLimitMiddleware(
    req: any,
    res: any,
    next: any
  ) {
    // 🔑 Chave única: prefixo + IP do cliente
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    const key = `${prefix}:${ip}`;
    const now = Date.now();

    let record = store.get(key);

    // ✅ Sem registro ainda — primeira tentativa
    if (!record) {
      store.set(key, { count: 1, firstAttempt: now });
      return next();
    }

    // 🚫 Verificar se está bloqueado
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

    // ♻️ Janela expirou — resetar contagem
    if (now - record.firstAttempt > windowMs) {
      record.count = 1;
      record.firstAttempt = now;
      delete record.blockedUntil;
      store.set(key, record);
      return next();
    }

    // ➕ Incrementar tentativas
    record.count += 1;

    // 🚫 Excedeu o limite — bloquear
    if (record.count > maxAttempts) {
      record.blockedUntil = now + blockDurationMs;
      store.set(key, record);

      const remainingSecs = Math.ceil(blockDurationMs / 1000);
      const remainingMins = Math.ceil(remainingSecs / 60);

      console.warn(
        `🚫 Rate limit atingido — IP: ${ip} | Rota: ${req.path} | Tentativas: ${record.count}`
      );

      res.setHeader("Retry-After", String(remainingSecs));
      res.setHeader("X-RateLimit-Limit", String(maxAttempts));
      res.setHeader("X-RateLimit-Remaining", "0");

      return res.status(429).json({
        error: message,
        retryAfter: remainingSecs,
        retryAfterMinutes: remainingMins,
      });
    }

    // ✅ Dentro do limite
    res.setHeader("X-RateLimit-Limit", String(maxAttempts));
    res.setHeader(
      "X-RateLimit-Remaining",
      String(maxAttempts - record.count)
    );

    store.set(key, record);
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
