import axios from "axios";
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

export type WebhookDeliveryEventType = "fallback_handoff";

export type DeliverWebhookOptions = {
  userId: number;
  url: string;
  payload: Record<string, unknown>;
  eventType?: WebhookDeliveryEventType;
  maxRetries?: number;
  timeoutMs?: number;
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
}: DeliverWebhookOptions): Promise<DeliverWebhookResult> {
  const safeMaxRetries = Math.max(1, maxRetries);
  let lastError = "erro desconhecido";

  for (let attempt = 1; attempt <= safeMaxRetries; attempt++) {
    try {
      await axios.post(url, payload, { timeout: timeoutMs });
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
