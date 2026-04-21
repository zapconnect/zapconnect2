import { buildWhatsAppJid, validatePhone } from "../utils/phoneUtils";
import { withTimeout } from "../utils/withTimeout";

type NumberStatusCheckResult = { canReceiveMessage?: boolean } | null;

export type ListValidationItemStatus =
  | "valid"
  | "invalid_format"
  | "not_on_whatsapp"
  | "unknown";

export type ListValidationItem = {
  input: string;
  sanitized: string;
  status: ListValidationItemStatus;
  reason?: string;
};

export type NumberListValidationResult = {
  totalNumbers: number;
  eligibleNumbers: number;
  invalidFormatCount: number;
  checkedCount: number;
  checkedResolvedCount: number;
  sampled: boolean;
  sampleSize: number;
  qualityScore: number | null;
  estimatedNotOnWhatsappCount: number | null;
  blocked: boolean;
  blockReason?: string;
  recommendation: string;
  warnings: string[];
  valid: string[];
  invalid: string[];
  notOnWhatsapp: string[];
  unknown: string[];
  checked: ListValidationItem[];
};

type ValidateNumberListOptions = {
  sampleSize?: number;
  fullCheckLimit?: number;
  timeoutMs?: number;
};

const DEFAULT_SAMPLE_SIZE = Number(
  process.env.DISPATCH_LIST_VALIDATION_SAMPLE_SIZE || 10
);
const DEFAULT_FULL_CHECK_LIMIT = Number(
  process.env.DISPATCH_LIST_VALIDATION_FULL_CHECK_LIMIT || 20
);
const DEFAULT_TIMEOUT_MS = Number(
  process.env.DISPATCH_LIST_VALIDATION_TIMEOUT_MS || 5_000
);
const DEFAULT_WARN_THRESHOLD = Number(
  process.env.DISPATCH_LIST_QUALITY_WARN_THRESHOLD || 80
);
const DEFAULT_BLOCK_THRESHOLD = Number(
  process.env.DISPATCH_LIST_QUALITY_BLOCK_THRESHOLD || 60
);
const CHECK_DELAY_MIN_MS = Number(
  process.env.DISPATCH_LIST_VALIDATION_DELAY_MIN_MS || 450
);
const CHECK_DELAY_MAX_MS = Number(
  process.env.DISPATCH_LIST_VALIDATION_DELAY_MAX_MS || 900
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function randomInt(min: number, max: number) {
  const safeMin = Math.max(0, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.floor(max));
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function pickDistributedSample(values: string[], limit: number) {
  if (values.length <= limit) return [...values];

  const picked: string[] = [];
  const used = new Set<string>();
  const step = values.length / limit;

  for (let index = 0; index < limit; index += 1) {
    const candidate = values[Math.min(values.length - 1, Math.floor(index * step))];
    if (!used.has(candidate)) {
      picked.push(candidate);
      used.add(candidate);
    }
  }

  if (picked.length >= limit) return picked.slice(0, limit);

  for (const value of values) {
    if (used.has(value)) continue;
    picked.push(value);
    used.add(value);
    if (picked.length >= limit) break;
  }

  return picked;
}

export async function validateNumberList(
  client: any,
  numbers: string[],
  options: ValidateNumberListOptions = {}
): Promise<NumberListValidationResult> {
  const sampleSize = Math.max(1, Number(options.sampleSize || DEFAULT_SAMPLE_SIZE));
  const fullCheckLimit = Math.max(
    1,
    Number(options.fullCheckLimit || DEFAULT_FULL_CHECK_LIMIT)
  );
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));

  const rawNumbers = Array.isArray(numbers) ? numbers : [];
  const invalid: string[] = [];
  const eligibleNumbers: string[] = [];
  const checked: ListValidationItem[] = [];
  const valid: string[] = [];
  const notOnWhatsapp: string[] = [];
  const unknown: string[] = [];
  const warnings: string[] = [];

  for (const entry of rawNumbers) {
    const raw = String(entry || "").trim();
    const { ok, sanitized } = validatePhone(raw);
    if (!ok) {
      invalid.push(raw);
      checked.push({
        input: raw,
        sanitized,
        status: "invalid_format",
        reason: "Formato invalido",
      });
      continue;
    }

    eligibleNumbers.push(sanitized);
  }

  const uniqueEligibleNumbers = Array.from(new Set(eligibleNumbers));
  const sampled = uniqueEligibleNumbers.length > fullCheckLimit;
  const numbersToCheck = sampled
    ? pickDistributedSample(uniqueEligibleNumbers, Math.min(sampleSize, uniqueEligibleNumbers.length))
    : uniqueEligibleNumbers;

  for (let index = 0; index < numbersToCheck.length; index += 1) {
    const sanitized = numbersToCheck[index];
    const jid = buildWhatsAppJid(sanitized);

    try {
      const status = await withTimeout<NumberStatusCheckResult>(
        client.checkNumberStatus(jid),
        timeoutMs,
        "checkNumberStatus"
      );

      if (status?.canReceiveMessage) {
        valid.push(sanitized);
        checked.push({
          input: sanitized,
          sanitized,
          status: "valid",
        });
      } else {
        notOnWhatsapp.push(sanitized);
        checked.push({
          input: sanitized,
          sanitized,
          status: "not_on_whatsapp",
          reason: "Nao registrado no WhatsApp",
        });
      }
    } catch (err: any) {
      unknown.push(sanitized);
      checked.push({
        input: sanitized,
        sanitized,
        status: "unknown",
        reason: String(err?.message || "Falha ao consultar o numero"),
      });
    }

    if (index < numbersToCheck.length - 1) {
      await sleep(randomInt(CHECK_DELAY_MIN_MS, CHECK_DELAY_MAX_MS));
    }
  }

  const resolvedSampleCount = valid.length + notOnWhatsapp.length;
  const estimatedNotOnWhatsappCount =
    eligibleNumbers.length > 0 && resolvedSampleCount > 0
      ? Math.max(
          0,
          Math.min(
            eligibleNumbers.length,
            Math.round(
              (notOnWhatsapp.length / Math.max(resolvedSampleCount, 1)) *
                eligibleNumbers.length
            )
          )
        )
      : null;

  const qualityScore =
    eligibleNumbers.length > 0 && estimatedNotOnWhatsappCount !== null
      ? clampPercent(
          ((eligibleNumbers.length - estimatedNotOnWhatsappCount) /
            Math.max(eligibleNumbers.length, 1)) *
            100
        )
      : null;

  const qualityLabel = sampled ? "estimada" : "confirmada";
  const checkedScopeLabel = sampled ? "da amostra" : "verificados";
  const baseRecommendation =
    qualityScore === null
      ? "Nao foi possivel concluir a validacao da lista agora. Tente novamente em alguns minutos."
      : `Qualidade ${qualityLabel} da lista: ${qualityScore}/100.`;

  if (sampled) {
    warnings.push(
      `Validacao de lista feita por amostra: ${numbersToCheck.length} numero(s) verificados entre ${eligibleNumbers.length} envio(s) elegiveis.`
    );
  }

  if (invalid.length) {
    warnings.push(
      `${invalid.length} numero(s) foram ignorados na validacao porque tinham formato invalido.`
    );
  }

  if (notOnWhatsapp.length) {
    warnings.push(
      `${notOnWhatsapp.length} numero(s) ${checkedScopeLabel} nao parecem registrados no WhatsApp.`
    );
  }

  if (unknown.length) {
    warnings.push(
      `Nao foi possivel confirmar ${unknown.length} numero(s) ${checkedScopeLabel}; a estimativa pode variar.`
    );
  }

  let recommendation = baseRecommendation;
  let blocked = false;
  let blockReason: string | undefined;

  if (qualityScore !== null && qualityScore < DEFAULT_BLOCK_THRESHOLD) {
    blocked = true;
    recommendation = `Lista com qualidade ${qualityLabel} em ${qualityScore}/100. Risco muito alto de bloqueios e banimento. Revise a base antes de disparar.`;
    blockReason =
      "A lista parece ter muitos numeros inativos ou fora do WhatsApp. Revise os contatos antes de continuar.";
  } else if (qualityScore !== null && qualityScore < DEFAULT_WARN_THRESHOLD) {
    recommendation = `Lista com qualidade ${qualityLabel} em ${qualityScore}/100. Revise os contatos antes de disparar para reduzir risco de bloqueios.`;
    warnings.push(recommendation);
  }

  return {
    totalNumbers: rawNumbers.length,
    eligibleNumbers: eligibleNumbers.length,
    invalidFormatCount: invalid.length,
    checkedCount: numbersToCheck.length,
    checkedResolvedCount: resolvedSampleCount,
    sampled,
    sampleSize: numbersToCheck.length,
    qualityScore,
    estimatedNotOnWhatsappCount,
    blocked,
    blockReason,
    recommendation,
    warnings,
    valid,
    invalid,
    notOnWhatsapp,
    unknown,
    checked,
  };
}
