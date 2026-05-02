import axios from "axios";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { getDB } from "../database";

const DEFAULT_WEBHOOK_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || 8000)
);
const DEFAULT_WEBHOOK_MAX_RETRIES = Math.max(
  1,
  Number(process.env.WEBHOOK_DELIVERY_MAX_RETRIES || 3)
);
const DEFAULT_WEBHOOK_BACKOFF_BASE_MS = Math.max(
  250,
  Number(process.env.WEBHOOK_DELIVERY_BACKOFF_BASE_MS || 1000)
);
const DEFAULT_WEBHOOK_BACKOFF_MAX_MS = Math.max(
  DEFAULT_WEBHOOK_BACKOFF_BASE_MS,
  Number(process.env.WEBHOOK_DELIVERY_BACKOFF_MAX_MS || 15000)
);
const WEBHOOK_ALLOWED_HOST_PATTERNS = String(
  process.env.WEBHOOK_ALLOWED_HOSTS || ""
)
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

export type WebhookDeliveryEventType = "fallback_handoff" | "flow_webhook";

export type DeliverWebhookOptions = {
  userId: number;
  url: string;
  payload: Record<string, unknown>;
  eventType?: WebhookDeliveryEventType;
  maxRetries?: number;
  timeoutMs?: number;
  headers?: Record<string, unknown>;
};

export type DeliverWebhookResult =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; error: string; failureId: number | null };

type PersistWebhookFailureInput = {
  userId: number;
  url: string;
  payload: Record<string, unknown>;
  eventType: WebhookDeliveryEventType;
  attempts: number;
  maxRetries: number;
  error: string;
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffDelay(attempt: number) {
  return Math.min(
    DEFAULT_WEBHOOK_BACKOFF_MAX_MS,
    DEFAULT_WEBHOOK_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1)
  );
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      error: "payload_unserializable",
      at: Date.now(),
    });
  }
}

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  minimum = 1
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.trunc(parsed));
}

function normalizeWebhookHeaders(headers: unknown) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }

  const normalizedEntries = Object.entries(headers).flatMap(([key, value]) => {
    const headerKey = String(key || "").trim();
    if (!headerKey) return [];
    return [[headerKey, String(value ?? "").trim()]];
  });

  return normalizedEntries.length
    ? Object.fromEntries(normalizedEntries)
    : undefined;
}

function isPrivateIpv4(host: string) {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string) {
  const normalized = host.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

function matchesAllowedWebhookHost(host: string) {
  if (!WEBHOOK_ALLOWED_HOST_PATTERNS.length) return true;

  return WEBHOOK_ALLOWED_HOST_PATTERNS.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix);
    }

    return host === pattern;
  });
}

export function isWebhookUrlSafe(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }

    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return false;

    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "metadata.google.internal"
    ) {
      return false;
    }

    if (!matchesAllowedWebhookHost(host)) {
      return false;
    }

    const ipVersion = net.isIP(host);
    if (ipVersion === 4) {
      return !isPrivateIpv4(host);
    }

    if (ipVersion === 6) {
      return !isPrivateIpv6(host);
    }

    return true;
  } catch {
    return false;
  }
}

async function isResolvedWebhookHostSafe(rawUrl: string) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return false;

    if (net.isIP(host)) {
      return true;
    }

    const results = await lookup(host, { all: true });
    if (!results.length) return false;

    return results.every((result) => {
      if (result.family === 4) {
        return !isPrivateIpv4(result.address);
      }

      if (result.family === 6) {
        return !isPrivateIpv6(result.address);
      }

      return false;
    });
  } catch {
    return false;
  }
}

function getWebhookErrorMessage(err: unknown) {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const statusText = err.response?.statusText;
    const responseBody =
      typeof err.response?.data === "string"
        ? err.response.data
        : err.response?.data
          ? safeJsonStringify(err.response.data)
          : "";

    return [status ? `HTTP ${status}` : "", statusText || "", err.message || "", responseBody.slice(0, 400)]
      .filter(Boolean)
      .join(" | ");
  }

  if (err instanceof Error) {
    return err.message;
  }

  return String(err || "erro desconhecido");
}

async function persistWebhookFailure(input: PersistWebhookFailureInput) {
  try {
    const db = getDB();
    const now = Date.now();
    const result = await db.run(
      `
      INSERT INTO webhook_delivery_failures (
        user_id,
        event_type,
        target_url,
        payload,
        attempts,
        max_attempts,
        status,
        last_error,
        last_attempt_at,
        next_retry_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'dead_letter', ?, ?, NULL, ?, ?)
      `,
      [
        input.userId,
        input.eventType,
        input.url,
        safeJsonStringify(input.payload),
        input.attempts,
        input.maxRetries,
        input.error,
        now,
        now,
        now,
      ]
    );

    return result.insertId || null;
  } catch (err) {
    console.error("Falha ao registrar webhook na dead-letter queue:", err);
    return null;
  }
}

export async function deliverWebhook({
  userId,
  url,
  payload,
  eventType = "fallback_handoff",
  maxRetries = DEFAULT_WEBHOOK_MAX_RETRIES,
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  headers,
}: DeliverWebhookOptions): Promise<DeliverWebhookResult> {
  const safeMaxRetries = normalizePositiveInt(
    maxRetries,
    DEFAULT_WEBHOOK_MAX_RETRIES
  );
  const safeTimeoutMs = normalizePositiveInt(
    timeoutMs,
    DEFAULT_WEBHOOK_TIMEOUT_MS,
    1000
  );
  const normalizedHeaders = normalizeWebhookHeaders(headers);
  let lastError = "erro desconhecido";

  if (!isWebhookUrlSafe(url) || !(await isResolvedWebhookHostSafe(url))) {
    lastError = "Webhook URL invalida ou nao permitida para saida HTTP.";
    const failureId = await persistWebhookFailure({
      userId,
      url,
      payload,
      eventType,
      attempts: 0,
      maxRetries: safeMaxRetries,
      error: lastError,
    });

    console.error(
      `❌ Webhook ${eventType} bloqueado por URL insegura para user ${userId}. Registro dead-letter: ${failureId ?? "sem id"}. URL: ${url}`
    );

    return {
      ok: false,
      attempts: 0,
      error: lastError,
      failureId,
    };
  }

  for (let attempt = 1; attempt <= safeMaxRetries; attempt++) {
    try {
      await axios.post(url, payload, {
        timeout: safeTimeoutMs,
        headers: normalizedHeaders,
      });
      console.log(
        `✅ Webhook ${eventType} entregue para user ${userId} em ${attempt} tentativa(s).`
      );
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = getWebhookErrorMessage(err);
      const lastAttempt = attempt === safeMaxRetries;

      if (!lastAttempt) {
        console.warn(
          `⚠️ Tentativa ${attempt}/${safeMaxRetries} do webhook ${eventType} falhou para user ${userId}: ${lastError}`
        );
        await wait(computeBackoffDelay(attempt));
        continue;
      }

      const failureId = await persistWebhookFailure({
        userId,
        url,
        payload,
        eventType,
        attempts: attempt,
        maxRetries: safeMaxRetries,
        error: lastError,
      });

      console.error(
        `❌ Webhook ${eventType} falhou após ${attempt} tentativa(s) para user ${userId}. Registro dead-letter: ${failureId ?? "sem id"}. Motivo: ${lastError}`
      );

      return {
        ok: false,
        attempts: attempt,
        error: lastError,
        failureId,
      };
    }
  }

  return {
    ok: false,
    attempts: safeMaxRetries,
    error: lastError,
    failureId: null,
  };
}
