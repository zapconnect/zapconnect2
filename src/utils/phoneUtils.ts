// src/utils/phoneUtils.ts
// Centraliza sanitização e validação de números de WhatsApp

export type PhoneValidationResult = {
  ok: boolean;
  sanitized: string;
  reason?: string;
};

const DEFAULT_MIN = 10; // ex: 551191234567 => 12/13 dígitos (Brasil)
const DEFAULT_MAX = 15; // limite E.164 para WhatsApp

export const sanitizePhone = (input: any): string =>
  String(input ?? "").replace(/\D/g, "");

export function validatePhone(
  input: any,
  opts?: { minLength?: number; maxLength?: number }
): PhoneValidationResult {
  const sanitized = sanitizePhone(input);
  const min = opts?.minLength ?? DEFAULT_MIN;
  const max = opts?.maxLength ?? DEFAULT_MAX;

  if (!sanitized) return { ok: false, sanitized, reason: "vazio" };
  if (sanitized.length < min) return { ok: false, sanitized, reason: "curto" };
  if (sanitized.length > max) return { ok: false, sanitized, reason: "longo" };
  if (/^0+/.test(sanitized)) return { ok: false, sanitized, reason: "zero à esquerda" };

  return { ok: true, sanitized };
}

export function assertValidPhone(input: any, label = "número"): string {
  const { ok, sanitized, reason } = validatePhone(input);
  if (!ok) {
    throw new Error(
      `Número de WhatsApp inválido (${label})${reason ? `: ${reason}` : ""}. Use DDI+DDD+telefone, apenas dígitos.`
    );
  }
  return sanitized;
}

export const buildWhatsAppJid = (sanitized: string): string => `${sanitized}@c.us`;

