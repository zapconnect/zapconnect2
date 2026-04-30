import { getDB } from "../database";
import type { ChargeMessageType } from "./cobrancaService";

export type ChargeWhatsappDeliveryStatus =
  | "FAILED"
  | "SENT"
  | "DELIVERED"
  | "READ";

const DELIVERY_STATUS_ORDER: Record<ChargeWhatsappDeliveryStatus, number> = {
  FAILED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

function ensureNumber(value: unknown, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isChargeWhatsappDeliveryStatus(
  value: unknown
): value is ChargeWhatsappDeliveryStatus {
  return (
    value === "FAILED" ||
    value === "SENT" ||
    value === "DELIVERED" ||
    value === "READ"
  );
}

export function parseChargeWhatsappDeliveryStatus(
  value: unknown
): ChargeWhatsappDeliveryStatus | null {
  return isChargeWhatsappDeliveryStatus(value) ? value : null;
}

export function normalizeChargeWhatsappMessageId(value: unknown): string | null {
  const direct =
    typeof value === "string"
      ? value
      : (value as any)?._serialized ||
        (value as any)?.id?._serialized ||
        (value as any)?.id ||
        null;

  const text = String(direct || "").trim();
  return text || null;
}

export function normalizeChargeWhatsappAckValue(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

export function getChargeWhatsappDeliveryStatusFromAck(
  ackValue: unknown
): ChargeWhatsappDeliveryStatus {
  const ack = normalizeChargeWhatsappAckValue(ackValue);
  if (ack == null) return "SENT";
  if (ack >= 3) return "READ";
  if (ack === 2) return "DELIVERED";
  if (ack >= 0) return "SENT";
  return "FAILED";
}

function shouldAdvanceChargeWhatsappStatus(
  currentAckValue: unknown,
  nextAckValue: number
) {
  const currentAck = normalizeChargeWhatsappAckValue(currentAckValue);
  if (currentAck == null) return true;

  const currentStatus = getChargeWhatsappDeliveryStatusFromAck(currentAck);
  const nextStatus = getChargeWhatsappDeliveryStatusFromAck(nextAckValue);

  if (nextStatus === "FAILED") {
    return currentAck <= 1;
  }

  const currentOrder = DELIVERY_STATUS_ORDER[currentStatus];
  const nextOrder = DELIVERY_STATUS_ORDER[nextStatus];

  if (nextOrder > currentOrder) return true;
  if (nextOrder === currentOrder && nextAckValue > currentAck) return true;

  return false;
}

export async function updateChargeWhatsappAckByMessageId(input: {
  userId: number;
  sessionName?: string | null;
  messageId: string;
  ack: unknown;
  occurredAt?: number;
}) {
  const messageId = normalizeChargeWhatsappMessageId(input.messageId);
  const ackValue = normalizeChargeWhatsappAckValue(input.ack);
  if (!messageId || ackValue == null) {
    return null;
  }

  const db = getDB();
  const params: any[] = [ensureNumber(input.userId), messageId];
  let whereSql = `user_id = ? AND whatsapp_ultima_mensagem_id = ?`;

  if (String(input.sessionName || "").trim()) {
    whereSql += ` AND session_name = ?`;
    params.push(String(input.sessionName).trim());
  }

  const row = await db.get<{
    id: number;
    whatsapp_ultimo_ack: number | null;
    whatsapp_ultimo_entregue_em: number | null;
    whatsapp_ultimo_lido_em: number | null;
  }>(
    `
    SELECT
      id,
      whatsapp_ultimo_ack,
      whatsapp_ultimo_entregue_em,
      whatsapp_ultimo_lido_em
    FROM cobrancas
    WHERE ${whereSql}
    LIMIT 1
    `,
    params
  );

  if (!row || !shouldAdvanceChargeWhatsappStatus(row.whatsapp_ultimo_ack, ackValue)) {
    return null;
  }

  const status = getChargeWhatsappDeliveryStatusFromAck(ackValue);
  const occurredAt = Math.max(1, ensureNumber(input.occurredAt, Date.now()));
  const deliveredAt =
    ackValue >= 2
      ? row.whatsapp_ultimo_entregue_em || occurredAt
      : row.whatsapp_ultimo_entregue_em;
  const readAt =
    ackValue >= 3
      ? row.whatsapp_ultimo_lido_em || occurredAt
      : row.whatsapp_ultimo_lido_em;

  await db.run(
    `
    UPDATE cobrancas
    SET
      whatsapp_ultimo_status = ?,
      whatsapp_ultimo_ack = ?,
      whatsapp_ultimo_erro = NULL,
      whatsapp_ultimo_entregue_em = ?,
      whatsapp_ultimo_lido_em = ?,
      whatsapp_ultimo_status_em = ?,
      updated_at = ?
    WHERE id = ?
    `,
    [
      status,
      ackValue,
      deliveredAt ?? null,
      readAt ?? null,
      occurredAt,
      occurredAt,
      row.id,
    ]
  );

  return {
    cobrancaId: ensureNumber(row.id),
    status,
    ack: ackValue,
  };
}

export function buildChargeWhatsappFailureSnapshot(input: {
  tipo: ChargeMessageType;
  sessionName?: string | null;
  error: string;
  occurredAt?: number;
}) {
  const occurredAt = Math.max(1, ensureNumber(input.occurredAt, Date.now()));

  return {
    tipo: input.tipo,
    sessionName: String(input.sessionName || "").trim() || null,
    status: "FAILED" as ChargeWhatsappDeliveryStatus,
    ack: -1,
    error: String(input.error || "Falha ao enviar mensagem via WhatsApp"),
    messageId: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    statusAt: occurredAt,
  };
}
