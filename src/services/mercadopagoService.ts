import crypto from "crypto";
import type { IncomingHttpHeaders } from "http";
import {
  MercadoPagoConfig,
  MerchantOrder,
  Payment,
  Preference,
  User as MercadoPagoUser,
} from "mercadopago";

import { getDB } from "../database";
import { emitToUser } from "../lib/socketEmitter";
import {
  buscarCobranca,
  enviarNotificacaoWhatsApp,
  marcarComoPago,
  type Cobranca,
} from "./cobrancaService";

type MercadoPagoSettingsRow = {
  id: number;
  user_id: number;
  access_token: string;
  public_key: string | null;
  webhook_secret: string | null;
  test_mode: number | boolean | null;
  notify_whatsapp: number | boolean | null;
  connected_at: number | null;
  created_at: number;
  updated_at: number;
};

type ChargeMpRow = {
  id: number;
  user_id: number;
  cliente_id: number;
  mp_preference_id: string | null;
  mp_payment_id: string | null;
  mp_checkout_url: string | null;
  mp_status: string | null;
  mp_updated_at: number | null;
  status: string;
  valor: number | string;
  valor_pago: number | string | null;
  pago_em: number | null;
  updated_at: number;
};

type ChargeClientRow = {
  email: string | null;
};

type MpWebhookLogRow = {
  id: number;
};

export type MpCredentials = {
  userId: number;
  accessToken: string;
  publicKey?: string;
  webhookSecret: string;
  testMode: boolean;
  notifyWhatsapp: boolean;
  connectedAt?: number;
};

export type MpPublicSettings = {
  configured: boolean;
  publicKey?: string;
  maskedAccessToken?: string;
  webhookUrl: string;
  testMode: boolean;
  notifyWhatsapp: boolean;
  connectedAt?: number;
  status: "connected" | "not_configured";
};

export type MpPayment = {
  id?: number;
  status?: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
  date_approved?: string;
  date_created?: string;
  date_last_updated?: string;
  payer?: {
    email?: string;
    first_name?: string;
    last_name?: string;
  };
  transaction_details?: {
    total_paid_amount?: number;
  };
};

type ProcessWebhookOptions = {
  logId?: number;
  eventType?: string;
};

type HandleWebhookInput = {
  userId: number;
  headers: IncomingHttpHeaders;
  query: Record<string, unknown>;
  body: Record<string, unknown> | null | undefined;
};

const MP_CIPHER_ALGORITHM = "aes-256-gcm";
const MP_CIPHER_VERSION = "v1";
const MP_IV_LENGTH = 12;

function nowMs() {
  return Date.now();
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown) {
  const text = normalizeText(value);
  return text || "";
}

function ensureBoolean(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function ensureNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundMoney(value: unknown) {
  return Math.round(ensureNumber(value) * 100) / 100;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error && typeof error === "object") {
    const input = error as Record<string, unknown>;
    const causeMessages = Array.isArray(input.cause)
      ? input.cause
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const cause = item as Record<string, unknown>;
            const description =
              normalizeText(cause.description) ||
              normalizeText(cause.message) ||
              normalizeText(cause.detail);
            const code = normalizeText(cause.code);
            return [code, description].filter(Boolean).join(": ");
          })
          .filter(Boolean)
      : [];

    const topLevelMessages = [
      normalizeText(input.message),
      normalizeText(input.error_description),
      normalizeText(input.error),
    ].filter(Boolean);

    const combined = [...topLevelMessages, ...causeMessages].join(" | ").trim();
    if (combined) {
      return combined;
    }
  }

  return fallback;
}

function getMpEncryptionKey() {
  const raw = normalizeText(process.env.MP_ENCRYPTION_KEY);
  if (!raw) {
    throw new Error("MP_ENCRYPTION_KEY não configurada.");
  }

  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error("MP_ENCRYPTION_KEY deve conter 64 caracteres hexadecimais.");
  }

  return Buffer.from(raw, "hex");
}

function encryptAccessToken(accessToken: string) {
  const key = getMpEncryptionKey();
  const iv = crypto.randomBytes(MP_IV_LENGTH);
  const cipher = crypto.createCipheriv(MP_CIPHER_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(accessToken, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    MP_CIPHER_VERSION,
    iv.toString("hex"),
    tag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

function decryptAccessToken(payload: string) {
  const [version, ivHex, tagHex, dataHex] = String(payload || "").split(":");
  if (
    version !== MP_CIPHER_VERSION ||
    !ivHex ||
    !tagHex ||
    !dataHex
  ) {
    throw new Error("Formato de credencial Mercado Pago inválido.");
  }

  const key = getMpEncryptionKey();
  const decipher = crypto.createDecipheriv(
    MP_CIPHER_ALGORITHM,
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function getWebhookSecret(row?: MercadoPagoSettingsRow | null) {
  return normalizeOptionalText(row?.webhook_secret) || crypto.randomBytes(24).toString("hex");
}

function isTestModeToken(accessToken: string) {
  return /^TEST-/i.test(normalizeText(accessToken));
}

function getBaseUrl() {
  const baseUrl = normalizeText(process.env.BASE_URL);
  if (!baseUrl) {
    throw new Error("BASE_URL não configurada para o checkout do Mercado Pago.");
  }

  return baseUrl.replace(/\/+$/, "");
}

function assertMercadoPagoReachableBaseUrl() {
  const baseUrl = getBaseUrl();
  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("BASE_URL inválida para o checkout do Mercado Pago.");
  }

  const host = parsed.hostname.toLowerCase();
  const isLocalHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.endsWith(".local");

  if (isLocalHost) {
    throw new Error(
      "BASE_URL está apontando para localhost. Para gerar checkout do Mercado Pago, use uma URL pública do app, como seu domínio ou um túnel (ex.: ngrok ou cloudflared)."
    );
  }

  return baseUrl;
}

export function buildMercadoPagoWebhookUrl(userId: number, webhookSecret: string) {
  const url = new URL(`${getBaseUrl()}/webhook/mercadopago/${userId}`);
  url.searchParams.set("secret", webhookSecret);
  return url.toString();
}

function buildMercadoPagoReturnUrl(state: "success" | "failure" | "pending") {
  return `${getBaseUrl()}/mp/${state}`;
}

function maskAccessToken(accessToken: string) {
  const token = normalizeText(accessToken);
  if (!token) return "";
  if (token.length <= 8) return "********";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

function createMpClient(accessToken: string) {
  return new MercadoPagoConfig({
    accessToken,
    options: {
      timeout: 10000,
    },
  });
}

async function getSettingsRow(userId: number) {
  const db = getDB();
  return db.get<MercadoPagoSettingsRow>(
    `
    SELECT *
    FROM mercadopago_settings
    WHERE user_id = ?
    LIMIT 1
    `,
    [userId]
  );
}

async function getChargeMpRow(userId: number, cobrancaId: number) {
  const db = getDB();
  return db.get<ChargeMpRow>(
    `
    SELECT
      id,
      user_id,
      cliente_id,
      mp_preference_id,
      mp_payment_id,
      mp_checkout_url,
      mp_status,
      mp_updated_at,
      status,
      valor,
      valor_pago,
      pago_em,
      updated_at
    FROM cobrancas
    WHERE user_id = ? AND id = ?
    LIMIT 1
    `,
    [userId, cobrancaId]
  );
}

async function getChargeClientEmail(userId: number, clienteId: number) {
  const db = getDB();
  const row = await db.get<ChargeClientRow>(
    `
    SELECT email
    FROM cobranca_clientes
    WHERE user_id = ? AND id = ?
    LIMIT 1
    `,
    [userId, clienteId]
  );

  return normalizeOptionalText(row?.email) || undefined;
}

async function mergeChargeMpState(
  userId: number,
  cobrancaId: number,
  updates: Partial<ChargeMpRow>
) {
  const db = getDB();
  const current = await getChargeMpRow(userId, cobrancaId);
  if (!current) {
    throw new Error("Cobrança não encontrada para atualizar o checkout.");
  }

  const next = {
    mp_preference_id:
      updates.mp_preference_id !== undefined
        ? updates.mp_preference_id
        : current.mp_preference_id,
    mp_payment_id:
      updates.mp_payment_id !== undefined
        ? updates.mp_payment_id
        : current.mp_payment_id,
    mp_checkout_url:
      updates.mp_checkout_url !== undefined
        ? updates.mp_checkout_url
        : current.mp_checkout_url,
    mp_status:
      updates.mp_status !== undefined ? updates.mp_status : current.mp_status,
    mp_updated_at:
      updates.mp_updated_at !== undefined
        ? updates.mp_updated_at
        : current.mp_updated_at,
  };

  await db.run(
    `
    UPDATE cobrancas
    SET
      mp_preference_id = ?,
      mp_payment_id = ?,
      mp_checkout_url = ?,
      mp_status = ?,
      mp_updated_at = ?,
      updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [
      next.mp_preference_id ?? null,
      next.mp_payment_id ?? null,
      next.mp_checkout_url ?? null,
      next.mp_status ?? null,
      next.mp_updated_at ?? null,
      nowMs(),
      userId,
      cobrancaId,
    ]
  );

  return buscarCobranca(userId, cobrancaId);
}

function normalizeMpStatus(status: unknown) {
  return normalizeText(status).toLowerCase();
}

function mapMpStatusToInternal(mpStatus: string) {
  if (mpStatus === "approved") return "PAGO";
  if (mpStatus === "refunded" || mpStatus === "charged_back") {
    return "CANCELADO";
  }
  if (mpStatus === "pending" || mpStatus === "in_process") {
    return "PENDENTE";
  }
  return null;
}

function extractChargeReference(externalReference: unknown) {
  const [chargeIdRaw, userIdRaw] = normalizeText(externalReference).split(":");
  const cobrancaId = Number(chargeIdRaw);
  const userId = Number(userIdRaw);

  if (!Number.isFinite(cobrancaId) || cobrancaId <= 0) return null;
  if (!Number.isFinite(userId) || userId <= 0) return null;

  return {
    cobrancaId,
    userId,
  };
}

function buildPreferenceExpirationDate(vencimento: string) {
  const dueDate = normalizeText(vencimento);
  if (!dueDate) return undefined;

  return new Date(`${dueDate}T23:59:59.000`).toISOString();
}

function buildSafeStatementDescriptor() {
  return "ZapConnect";
}

async function createWebhookLog(
  userId: number,
  rawPayload: string,
  eventType: string,
  paymentId?: string | null
) {
  const db = getDB();
  const result = await db.run(
    `
    INSERT INTO mp_webhook_logs (
      user_id,
      cobranca_id,
      payment_id,
      event_type,
      mp_status,
      raw_payload,
      processed,
      error,
      created_at
    ) VALUES (?, NULL, ?, ?, NULL, ?, 0, NULL, ?)
    `,
    [userId, paymentId ?? null, eventType || "unknown", rawPayload, nowMs()]
  );

  return ensureNumber(result.insertId);
}

async function finalizeWebhookLog(
  logId: number,
  input: {
    cobrancaId?: number | null;
    paymentId?: string | null;
    mpStatus?: string | null;
    processed?: boolean;
    error?: string | null;
  }
) {
  const db = getDB();
  await db.run(
    `
    UPDATE mp_webhook_logs
    SET
      cobranca_id = ?,
      payment_id = ?,
      mp_status = ?,
      processed = ?,
      error = ?
    WHERE id = ?
    `,
    [
      input.cobrancaId ?? null,
      input.paymentId ?? null,
      input.mpStatus ?? null,
      input.processed ? 1 : 0,
      input.error ?? null,
      logId,
    ]
  );
}

async function hasProcessedWebhookStatus(
  userId: number,
  paymentId: string,
  mpStatus: string,
  currentLogId?: number
) {
  const db = getDB();
  const row = await db.get<MpWebhookLogRow>(
    `
    SELECT id
    FROM mp_webhook_logs
    WHERE user_id = ?
      AND payment_id = ?
      AND mp_status = ?
      AND processed = 1
      AND (? IS NULL OR id <> ?)
    ORDER BY id DESC
    LIMIT 1
    `,
    [userId, paymentId, mpStatus, currentLogId ?? null, currentLogId ?? null]
  );

  return Boolean(row?.id);
}

async function reserveOnlinePaymentConfirmation(
  userId: number,
  cobrancaId: number
) {
  const db = getDB();
  const result = await db.run(
    `
    UPDATE cobrancas
    SET
      notificado_confirmacao_pagamento = 1,
      updated_at = ?
    WHERE user_id = ?
      AND id = ?
      AND COALESCE(notificado_confirmacao_pagamento, 0) = 0
    `,
    [nowMs(), userId, cobrancaId]
  );

  return result.affectedRows === 1;
}

async function releaseOnlinePaymentConfirmationReservation(
  userId: number,
  cobrancaId: number
) {
  const db = getDB();
  await db.run(
    `
    UPDATE cobrancas
    SET
      notificado_confirmacao_pagamento = 0,
      updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [nowMs(), userId, cobrancaId]
  );
}

async function forceCancelChargeByMp(
  userId: number,
  cobrancaId: number,
  mpStatus: string,
  paymentId: string
) {
  const updated = await mergeChargeMpState(userId, cobrancaId, {
    mp_payment_id: paymentId,
    mp_status: mpStatus,
    mp_updated_at: nowMs(),
  });

  if (!updated) {
    throw new Error("Cobrança não encontrada após atualizar status do Mercado Pago.");
  }

  const db = getDB();
  await db.run(
    `
    UPDATE cobrancas
    SET status = 'CANCELADO', updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [nowMs(), userId, cobrancaId]
  );

  return buscarCobranca(userId, cobrancaId);
}

async function testCredentials(
  accessToken: string
): Promise<{ ok: boolean; accountName?: string; error?: string }> {
  try {
    const client = createMpClient(accessToken);
    const account = await new MercadoPagoUser(client).get();
    const accountName = [account.first_name, account.last_name]
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join(" ")
      || normalizeOptionalText(account.nickname)
      || normalizeOptionalText(account.email)
      || `Conta ${String(account.id || "").trim()}`;

    return {
      ok: true,
      accountName,
    };
  } catch (error) {
    return {
      ok: false,
      error: getErrorMessage(error, "Não foi possível validar a conta no Mercado Pago."),
    };
  }
}

export async function getMpCredentials(userId: number): Promise<MpCredentials | null> {
  const row = await getSettingsRow(userId);
  if (!row?.access_token) return null;

  return {
    userId,
    accessToken: decryptAccessToken(row.access_token),
    publicKey: normalizeOptionalText(row.public_key) || undefined,
    webhookSecret: getWebhookSecret(row),
    testMode: ensureBoolean(row.test_mode),
    notifyWhatsapp: ensureBoolean(row.notify_whatsapp),
    connectedAt: row.connected_at == null ? undefined : ensureNumber(row.connected_at),
  };
}

export async function getMpPublicSettings(
  userId: number
): Promise<MpPublicSettings> {
  const credentials = await getMpCredentials(userId);
  if (!credentials) {
    return {
      configured: false,
      webhookUrl: "",
      testMode: false,
      notifyWhatsapp: false,
      status: "not_configured",
    };
  }

  return {
    configured: true,
    publicKey: credentials.publicKey,
    maskedAccessToken: maskAccessToken(credentials.accessToken),
    webhookUrl: buildMercadoPagoWebhookUrl(userId, credentials.webhookSecret),
    testMode: credentials.testMode,
    notifyWhatsapp: credentials.notifyWhatsapp,
    connectedAt: credentials.connectedAt,
    status: "connected",
  };
}

export async function saveMpCredentials(
  userId: number,
  accessToken: string,
  publicKey: string,
  options: { notifyWhatsapp?: boolean } = {}
): Promise<void> {
  const existing = await getSettingsRow(userId);
  const normalizedAccessToken =
    normalizeText(accessToken) ||
    (existing?.access_token ? decryptAccessToken(existing.access_token) : "");
  const normalizedPublicKey = normalizeOptionalText(publicKey);

  if (!normalizedAccessToken) {
    throw new Error("Informe o Access Token do Mercado Pago.");
  }

  const connection = await testCredentials(normalizedAccessToken);
  if (!connection.ok) {
    throw new Error(connection.error || "Credenciais do Mercado Pago inválidas.");
  }

  const db = getDB();
  const timestamp = nowMs();
  const encryptedAccessToken = encryptAccessToken(normalizedAccessToken);
  const webhookSecret = getWebhookSecret(existing);
  const notifyWhatsapp = options.notifyWhatsapp ? 1 : 0;
  const testMode = isTestModeToken(normalizedAccessToken) ? 1 : 0;

  if (existing?.id) {
    await db.run(
      `
      UPDATE mercadopago_settings
      SET
        access_token = ?,
        public_key = ?,
        webhook_secret = ?,
        test_mode = ?,
        notify_whatsapp = ?,
        connected_at = ?,
        updated_at = ?
      WHERE user_id = ?
      `,
      [
        encryptedAccessToken,
        normalizedPublicKey || null,
        webhookSecret,
        testMode,
        notifyWhatsapp,
        timestamp,
        timestamp,
        userId,
      ]
    );
    return;
  }

  await db.run(
    `
    INSERT INTO mercadopago_settings (
      user_id,
      access_token,
      public_key,
      webhook_secret,
      test_mode,
      notify_whatsapp,
      connected_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      userId,
      encryptedAccessToken,
      normalizedPublicKey || null,
      webhookSecret,
      testMode,
      notifyWhatsapp,
      timestamp,
      timestamp,
      timestamp,
    ]
  );
}

export async function disconnectMpCredentials(userId: number): Promise<void> {
  const db = getDB();
  await db.run(`DELETE FROM mercadopago_settings WHERE user_id = ?`, [userId]);
}

export async function testMpConnection(
  userId: number,
  draft?: { accessToken?: string }
): Promise<{ ok: boolean; accountName?: string; error?: string }> {
  const draftToken = normalizeText(draft?.accessToken);
  if (draftToken) {
    return testCredentials(draftToken);
  }

  const credentials = await getMpCredentials(userId);
  if (!credentials?.accessToken) {
    return {
      ok: false,
      error: "Configure o Access Token antes de testar a conexão.",
    };
  }

  return testCredentials(credentials.accessToken);
}

export async function createCheckoutPreference(
  userId: number,
  cobranca: Cobranca,
  options: { expireOnDueDate?: boolean; force?: boolean } = {}
): Promise<{ preferenceId: string; checkoutUrl: string; cobranca: Cobranca }> {
  assertMercadoPagoReachableBaseUrl();

  const credentials = await getMpCredentials(userId);
  if (!credentials) {
    throw new Error("Mercado Pago não configurado para este usuário.");
  }

  if (cobranca.status === "CANCELADO" || cobranca.status === "PAGO") {
    throw new Error("Somente cobranças abertas podem gerar checkout online.");
  }

  if (cobranca.mp_checkout_url && !options.force) {
    return {
      preferenceId: normalizeOptionalText(cobranca.mp_preference_id),
      checkoutUrl: cobranca.mp_checkout_url,
      cobranca,
    };
  }

  const client = createMpClient(credentials.accessToken);
  const preference = new Preference(client);
  const clienteEmail = await getChargeClientEmail(userId, cobranca.cliente_id);
  const expirationDateTo =
    options.expireOnDueDate === false
      ? undefined
      : buildPreferenceExpirationDate(cobranca.vencimento);

  const result = await preference.create({
    body: {
      items: [
        {
          id: String(cobranca.id),
          title: normalizeText(cobranca.descricao) || "Cobrança ZapConnect",
          quantity: 1,
          currency_id: "BRL",
          unit_price: roundMoney(cobranca.valor),
        },
      ],
      payer: {
        name: cobranca.cliente_nome,
        ...(clienteEmail ? { email: clienteEmail } : {}),
      },
      back_urls: {
        success: buildMercadoPagoReturnUrl("success"),
        failure: buildMercadoPagoReturnUrl("failure"),
        pending: buildMercadoPagoReturnUrl("pending"),
      },
      auto_return: "approved",
      notification_url: buildMercadoPagoWebhookUrl(
        userId,
        credentials.webhookSecret
      ),
      external_reference: `${cobranca.id}:${userId}`,
      statement_descriptor: buildSafeStatementDescriptor(),
      expires: Boolean(expirationDateTo),
      expiration_date_from: new Date().toISOString(),
      ...(expirationDateTo
        ? { expiration_date_to: expirationDateTo }
        : {}),
    },
    requestOptions: {
      idempotencyKey: crypto.randomUUID(),
    },
  });

  const preferenceId = normalizeText(result.id);
  const checkoutUrl = normalizeText(
    credentials.testMode
      ? result.sandbox_init_point || result.init_point
      : result.init_point || result.sandbox_init_point
  );

  if (!preferenceId || !checkoutUrl) {
    throw new Error("O Mercado Pago não retornou um link de checkout válido.");
  }

  const updated = await mergeChargeMpState(userId, cobranca.id, {
    mp_preference_id: preferenceId,
    mp_payment_id: null,
    mp_checkout_url: checkoutUrl,
    mp_status: "pending",
    mp_updated_at: nowMs(),
  });

  if (!updated) {
    throw new Error("Cobrança não encontrada após gerar checkout.");
  }

  return {
    preferenceId,
    checkoutUrl,
    cobranca: updated,
  };
}

export async function fetchMpPayment(
  userId: number,
  paymentId: string
): Promise<MpPayment> {
  const credentials = await getMpCredentials(userId);
  if (!credentials) {
    throw new Error("Mercado Pago não configurado para este usuário.");
  }

  const numericPaymentId = Number(paymentId);
  if (!Number.isFinite(numericPaymentId) || numericPaymentId <= 0) {
    throw new Error("ID de pagamento do Mercado Pago inválido.");
  }

  const client = createMpClient(credentials.accessToken);
  const payment = await new Payment(client).get({
    id: numericPaymentId,
  });

  return {
    id: payment.id,
    status: payment.status,
    status_detail: payment.status_detail,
    external_reference: payment.external_reference,
    transaction_amount: payment.transaction_amount,
    date_approved: payment.date_approved,
    date_created: payment.date_created,
    date_last_updated: payment.date_last_updated,
    payer: payment.payer,
    transaction_details: payment.transaction_details,
  };
}

async function sendOnlinePaymentConfirmationIfNeeded(
  userId: number,
  cobranca: Cobranca,
  shouldNotify: boolean
) {
  if (!shouldNotify || cobranca.status !== "PAGO") return null;

  const reserved = await reserveOnlinePaymentConfirmation(userId, cobranca.id);
  if (!reserved) return null;

  try {
    const result = await enviarNotificacaoWhatsApp(
      userId,
      cobranca,
      "confirmacao_pagamento"
    );
    if (result.ok) return null;

    await releaseOnlinePaymentConfirmationReservation(userId, cobranca.id);
    return normalizeText(result.error) || "whatsapp_confirmation_failed";
  } catch (error) {
    await releaseOnlinePaymentConfirmationReservation(userId, cobranca.id);
    console.error(
      "Falha ao enviar confirmação de pagamento online no WhatsApp:",
      error
    );
    return getErrorMessage(
      error,
      "whatsapp_confirmation_unexpected_failure"
    );
  }
}

function getPaymentApprovedDateOnly(payment: MpPayment) {
  const iso =
    normalizeText(payment.date_approved) ||
    normalizeText(payment.date_last_updated) ||
    normalizeText(payment.date_created);

  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

function getPaymentReceivedAmount(charge: Cobranca, payment: MpPayment) {
  const paidAmount = roundMoney(
    payment.transaction_details?.total_paid_amount ??
      payment.transaction_amount ??
      0
  );
  const remaining = Math.max(
    0,
    roundMoney(charge.valor) - roundMoney(charge.valor_pago ?? 0)
  );

  if (remaining > 0) {
    return Math.min(remaining, paidAmount || remaining);
  }

  return paidAmount;
}

export async function processWebhookPayment(
  userId: number,
  paymentId: string,
  options: ProcessWebhookOptions = {}
): Promise<{ cobrancaId: number; newStatus: string; duplicated?: boolean }> {
  const payment = await fetchMpPayment(userId, paymentId);
  const mpStatus = normalizeMpStatus(payment.status);
  const reference = extractChargeReference(payment.external_reference);

  if (!reference || reference.userId !== userId) {
    throw new Error("Referência externa do pagamento inválida para este usuário.");
  }

  if (
    mpStatus &&
    (await hasProcessedWebhookStatus(
      userId,
      String(payment.id || paymentId),
      mpStatus,
      options.logId
    ))
  ) {
    if (options.logId) {
      await finalizeWebhookLog(options.logId, {
        cobrancaId: reference.cobrancaId,
        paymentId: String(payment.id || paymentId),
        mpStatus,
        processed: true,
        error: "duplicate_ignored",
      });
    }

    const current = await buscarCobranca(userId, reference.cobrancaId);
    return {
      cobrancaId: reference.cobrancaId,
      newStatus: current?.status || "PENDENTE",
      duplicated: true,
    };
  }

  const current = await buscarCobranca(userId, reference.cobrancaId);
  if (!current) {
    throw new Error("Cobrança vinculada ao pagamento não encontrada.");
  }

  let updatedCharge = await mergeChargeMpState(userId, reference.cobrancaId, {
    mp_payment_id: String(payment.id || paymentId),
    mp_status: mpStatus || current.mp_status || "pending",
    mp_updated_at: nowMs(),
  });
  let processingWarning: string | null = null;

  if (!updatedCharge) {
    throw new Error("Cobrança não encontrada após atualizar status do pagamento.");
  }

  const previousStatus = current.status;
  const internalStatus = mapMpStatusToInternal(mpStatus);

  if (internalStatus === "PAGO") {
    updatedCharge = await marcarComoPago(
      userId,
      reference.cobrancaId,
      getPaymentReceivedAmount(current, payment),
      getPaymentApprovedDateOnly(payment),
      `Pagamento Mercado Pago #${String(payment.id || paymentId)}`
    );

    updatedCharge =
      (await mergeChargeMpState(userId, reference.cobrancaId, {
        mp_payment_id: String(payment.id || paymentId),
        mp_status: mpStatus || "approved",
        mp_updated_at: nowMs(),
      })) || updatedCharge;

    emitToUser(userId, "cobranca:paga", updatedCharge);

    const credentials = await getMpCredentials(userId);
    processingWarning = await sendOnlinePaymentConfirmationIfNeeded(
      userId,
      updatedCharge,
      Boolean(credentials?.notifyWhatsapp && previousStatus !== "PAGO")
    );
  } else if (internalStatus === "CANCELADO") {
    updatedCharge = await forceCancelChargeByMp(
      userId,
      reference.cobrancaId,
      mpStatus || "cancelled",
      String(payment.id || paymentId)
    );

    if (!updatedCharge) {
      throw new Error("Cobrança não encontrada após cancelar pagamento online.");
    }

    emitToUser(userId, "cobranca:atualizada", updatedCharge);
  } else {
    emitToUser(userId, "cobranca:atualizada", updatedCharge);
  }

  if (options.logId) {
    await finalizeWebhookLog(options.logId, {
      cobrancaId: reference.cobrancaId,
      paymentId: String(payment.id || paymentId),
      mpStatus: mpStatus || null,
      processed: true,
      error: processingWarning,
    });
  }

  return {
    cobrancaId: reference.cobrancaId,
    newStatus: updatedCharge?.status || current.status,
  };
}

export async function processWebhookMerchantOrder(
  userId: number,
  merchantOrderId: string,
  options: ProcessWebhookOptions = {}
) {
  const credentials = await getMpCredentials(userId);
  if (!credentials) {
    throw new Error("Mercado Pago não configurado para este usuário.");
  }

  const numericMerchantOrderId = Number(merchantOrderId);
  if (!Number.isFinite(numericMerchantOrderId) || numericMerchantOrderId <= 0) {
    throw new Error("Merchant order do Mercado Pago inválida.");
  }

  const client = createMpClient(credentials.accessToken);
  const order = await new MerchantOrder(client).get({
    merchantOrderId: numericMerchantOrderId,
  });

  const payments = Array.isArray(order.payments) ? order.payments : [];
  const candidate = payments
    .filter((item) => Number.isFinite(Number(item.id)))
    .sort((a, b) => {
      const aTime = new Date(
        normalizeText(a.last_modified) ||
          normalizeText(a.date_approved) ||
          normalizeText(a.date_created) ||
          0
      ).getTime();
      const bTime = new Date(
        normalizeText(b.last_modified) ||
          normalizeText(b.date_approved) ||
          normalizeText(b.date_created) ||
          0
      ).getTime();
      return bTime - aTime;
    })[0];

  if (!candidate?.id) {
    throw new Error("Merchant order sem pagamento associado.");
  }

  return processWebhookPayment(userId, String(candidate.id), options);
}

export async function refreshChargeMpStatus(userId: number, cobrancaId: number) {
  const charge = await buscarCobranca(userId, cobrancaId);
  if (!charge) {
    throw new Error("Cobrança não encontrada.");
  }

  if (charge.mp_payment_id) {
    try {
      await processWebhookPayment(userId, charge.mp_payment_id);
    } catch (error) {
      await mergeChargeMpState(userId, cobrancaId, {
        mp_status: charge.mp_status || "pending",
        mp_updated_at: nowMs(),
      });
      throw error;
    }
  }

  const updated = await buscarCobranca(userId, cobrancaId);
  if (!updated) {
    throw new Error("Cobrança não encontrada após sincronizar status.");
  }

  return updated;
}

function extractWebhookEventType(query: Record<string, unknown>, body?: Record<string, unknown> | null) {
  return normalizeText(
    body?.type ??
      body?.["topic"] ??
      query["type"] ??
      query["topic"]
  ).toLowerCase();
}

function extractWebhookResourceId(query: Record<string, unknown>, body?: Record<string, unknown> | null) {
  const data = body?.data;
  if (data && typeof data === "object" && "id" in data) {
    return normalizeText((data as { id?: unknown }).id);
  }

  return normalizeText(query["data.id"] ?? query["id"]);
}

function normalizeWebhookSecret(query: Record<string, unknown>) {
  return normalizeText(query["secret"]);
}

function extractHeaderSecretCandidates(value: unknown) {
  const raw = normalizeText(value);
  if (!raw) return [];

  const tokens = new Set<string>();
  tokens.add(raw);

  raw.split(",").forEach((chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    tokens.add(trimmed);

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex > 0) {
      tokens.add(trimmed.slice(separatorIndex + 1).trim());
    }
  });

  return Array.from(tokens).filter(Boolean);
}

function isWebhookSecretValid(input: HandleWebhookInput, expectedSecret: string) {
  const candidates = new Set<string>([
    normalizeWebhookSecret(input.query),
    ...extractHeaderSecretCandidates(input.headers["x-signature"]),
    ...extractHeaderSecretCandidates(input.headers["x-hub-signature"]),
  ]);

  return candidates.has(expectedSecret);
}

function buildWebhookRawPayload(input: HandleWebhookInput) {
  const safeHeaders = {
    "x-request-id": normalizeText(input.headers["x-request-id"]),
    "x-signature": normalizeText(input.headers["x-signature"]),
    "x-hub-signature": normalizeText(input.headers["x-hub-signature"]),
  };

  try {
    return JSON.stringify({
      query: input.query || {},
      body: input.body || {},
      headers: safeHeaders,
    });
  } catch {
    return JSON.stringify({
      query: input.query || {},
      headers: safeHeaders,
      body: "[unserializable]",
    });
  }
}

export async function handleMpWebhookNotification(input: HandleWebhookInput) {
  const eventType = extractWebhookEventType(input.query, input.body);
  const resourceId = extractWebhookResourceId(input.query, input.body);
  const rawPayload = buildWebhookRawPayload(input);
  const logId = await createWebhookLog(
    input.userId,
    rawPayload,
    eventType || "unknown",
    resourceId || null
  );

  try {
    const settings = await getSettingsRow(input.userId);
    const expectedSecret = getWebhookSecret(settings);

    if (!settings?.id || !settings.access_token) {
      throw new Error("Integração Mercado Pago não configurada.");
    }

    // No fluxo com Access Token manual, validamos a origem usando um segredo
    // exclusivo por operador embutido na notification_url. Também aceitamos
    // esse segredo ecoado em x-signature/x-hub-signature quando houver proxy
    // intermediando a chamada. Em seguida confirmamos o evento na API do MP.
    if (!isWebhookSecretValid(input, expectedSecret)) {
      throw new Error("Segredo do webhook do Mercado Pago inválido.");
    }

    if (eventType === "payment") {
      if (!resourceId) {
        throw new Error("Webhook de pagamento sem data.id.");
      }

      await processWebhookPayment(input.userId, resourceId, {
        logId,
        eventType,
      });
      return;
    }

    if (eventType === "merchant_order") {
      if (!resourceId) {
        throw new Error("Webhook de merchant_order sem data.id.");
      }

      await processWebhookMerchantOrder(input.userId, resourceId, {
        logId,
        eventType,
      });
      return;
    }

    await finalizeWebhookLog(logId, {
      processed: true,
      error: "ignored_event",
    });
  } catch (error) {
    await finalizeWebhookLog(logId, {
      paymentId: resourceId || null,
      processed: false,
      error: getErrorMessage(error, "Falha ao processar webhook do Mercado Pago."),
    });
  }
}
