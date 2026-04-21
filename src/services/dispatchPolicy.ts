import { getDB } from "../database";

export type DispatchTarget = {
  number: string;
  message?: string;
  vars?: Record<string, string>;
};

export type DispatchPolicySkip = {
  number: string;
  code: string;
  reason: string;
};

export type DispatchCampaignKind = "broadcast" | "schedule";

export type DispatchPolicyResult = {
  allowedContacts: DispatchTarget[];
  skippedContacts: DispatchPolicySkip[];
  warnings: string[];
  blocked: boolean;
  blockReason?: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
};

export type DispatchContactEventInput = {
  userId: number;
  sessionName?: string | null;
  campaignKind: DispatchCampaignKind;
  campaignRef?: string | null;
  phone: string;
  status: "sent" | "error" | "skipped";
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
};

export type DispatchSessionHealth = {
  blocked: boolean;
  reason?: string;
  warnings: string[];
  consecutiveErrors: number;
  total: number;
  errorRate: number;
};

export type DispatchCampaignRisk = {
  blocked: boolean;
  reason?: string;
  warnings: string[];
  plannedCount: number;
  sentToday: number;
  dailySafeLimit: number;
  sessionSentToday: number | null;
  sessionWarmupDailyLimit: number | null;
  sessionAgeDays: number | null;
};

export type DispatchConsentCommand =
  | { type: "opt_out"; normalizedText: string }
  | { type: "opt_in"; normalizedText: string }
  | null;

type DBClient = ReturnType<typeof getDB>;

const DISPATCH_BUSINESS_START_HOUR = Number(
  process.env.DISPATCH_BUSINESS_START_HOUR || 8
);
const DISPATCH_BUSINESS_END_HOUR = Number(
  process.env.DISPATCH_BUSINESS_END_HOUR || 21
);
const DISPATCH_LARGE_BATCH_WARNING_THRESHOLD = Number(
  process.env.DISPATCH_LARGE_BATCH_WARNING_THRESHOLD || 25
);
const DISPATCH_CONTACT_COOLDOWN_MS = Number(
  process.env.DISPATCH_CONTACT_COOLDOWN_MS || 6 * 60 * 60 * 1000
);
const DISPATCH_RECENT_FAILURE_WINDOW_MS = Number(
  process.env.DISPATCH_RECENT_FAILURE_WINDOW_MS || 7 * 24 * 60 * 60 * 1000
);
const DISPATCH_RECENT_FAILURE_LIMIT = Number(
  process.env.DISPATCH_RECENT_FAILURE_LIMIT || 3
);
const SESSION_HEALTH_WINDOW_MS = Number(
  process.env.DISPATCH_SESSION_HEALTH_WINDOW_MS || 60 * 60 * 1000
);
export const DISPATCH_CONSECUTIVE_FAILURE_LIMIT = Number(
  process.env.DISPATCH_CONSECUTIVE_FAILURE_LIMIT || 4
);
export const DISPATCH_ERROR_RATE_SAMPLE_SIZE = Number(
  process.env.DISPATCH_ERROR_RATE_SAMPLE_SIZE || 5
);
export const DISPATCH_ERROR_RATE_THRESHOLD = Number(
  process.env.DISPATCH_ERROR_RATE_THRESHOLD || 0.5
);
const DAY_MS = 24 * 60 * 60 * 1000;
const DISPATCH_DAILY_SAFE_LIMIT = Number(
  process.env.DISPATCH_DAILY_SAFE_LIMIT || 500
);
const DISPATCH_HIGH_RISK_BATCH_THRESHOLD = Number(
  process.env.DISPATCH_HIGH_RISK_BATCH_THRESHOLD || 100
);
const DISPATCH_SESSION_WARMUP_DAYS = Number(
  process.env.DISPATCH_SESSION_WARMUP_DAYS || 7
);
const DISPATCH_SESSION_WARMUP_DAILY_LIMIT = Number(
  process.env.DISPATCH_SESSION_WARMUP_DAILY_LIMIT || 30
);
const DISPATCH_SESSION_WARMUP_WARNING_THRESHOLD = Number(
  process.env.DISPATCH_SESSION_WARMUP_WARNING_THRESHOLD || 20
);

const OPT_OUT_EXACT = new Set([
  "parar",
  "pare",
  "sair",
  "stop",
  "cancelar",
  "cancela",
  "descadastrar",
  "unsubscribe",
  "optout",
  "nao quero receber",
  "não quero receber",
  "remover",
  "remova",
]);

const OPT_IN_EXACT = new Set([
  "start",
  "voltar",
  "retomar",
  "reativar",
  "quero receber",
  "voltei",
]);

function resolveDb(db?: DBClient): DBClient {
  return db || getDB();
}

function buildInClause(values: unknown[]) {
  return values.map(() => "?").join(", ");
}

function normalizePhoneForStorage(phone: string): string {
  return String(phone || "").replace(/\D/g, "");
}

function normalizeConsentText(text: string): string {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localHourFromOffset(timestamp: number, timezoneOffset: number) {
  return new Date(timestamp + timezoneOffset * 60_000).getUTCHours();
}

function localDayBoundsFromOffset(timestamp: number, timezoneOffset: number) {
  const local = new Date(timestamp + timezoneOffset * 60_000);
  const start =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      0,
      0,
      0,
      0
    ) - timezoneOffset * 60_000;

  return {
    start,
    end: start + DAY_MS,
  };
}

function coerceDateToMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : null;
  }

  return null;
}

async function getUserTimezoneOffset(db: DBClient, userId: number) {
  const row = await db.get<{ timezone_offset: number | null }>(
    `SELECT timezone_offset FROM users WHERE id = ?`,
    [userId]
  );
  return Number(row?.timezone_offset ?? -180);
}

async function countSentDispatches(input: {
  db: DBClient;
  userId: number;
  start: number;
  end: number;
  sessionName?: string | null;
}) {
  const params: Array<number | string> = [input.userId, input.start, input.end];
  let sql = `SELECT COUNT(*) as total
    FROM dispatch_contact_events
    WHERE user_id = ?
      AND status = 'sent'
      AND created_at >= ?
      AND created_at < ?`;

  if (input.sessionName) {
    sql += ` AND session_name = ?`;
    params.push(input.sessionName);
  }

  const row = await input.db.get<{ total: number | null }>(sql, params);
  return Number(row?.total || 0);
}

async function loadSessionCreatedAtMs(
  db: DBClient,
  userId: number,
  sessionName: string
) {
  const row = await db.get<{ created_at: unknown }>(
    `SELECT created_at FROM sessions WHERE user_id = ? AND session_name = ? LIMIT 1`,
    [userId, sessionName]
  );
  return coerceDateToMs(row?.created_at);
}

async function loadSuppressions(
  db: DBClient,
  userId: number,
  phones: string[]
): Promise<Map<string, { reason: string; source: string }>> {
  const map = new Map<string, { reason: string; source: string }>();
  if (!phones.length) return map;

  const placeholders = buildInClause(phones);
  const rows = await db.all<{ phone: string; reason: string; source: string }>(
    `SELECT phone, reason, source
     FROM dispatch_suppressions
     WHERE user_id = ?
       AND status = 'active'
       AND phone IN (${placeholders})`,
    [userId, ...phones]
  );

  for (const row of rows) {
    map.set(normalizePhoneForStorage(row.phone), {
      reason: row.reason || "suppressed",
      source: row.source || "unknown",
    });
  }

  return map;
}

async function loadCooldownHits(
  db: DBClient,
  userId: number,
  phones: string[],
  now: number
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!phones.length || DISPATCH_CONTACT_COOLDOWN_MS <= 0) return map;

  const cutoff = now - DISPATCH_CONTACT_COOLDOWN_MS;
  const placeholders = buildInClause(phones);
  const rows = await db.all<{ phone: string; last_sent_at: number }>(
    `SELECT phone, MAX(created_at) as last_sent_at
     FROM dispatch_contact_events
     WHERE user_id = ?
       AND status = 'sent'
       AND created_at >= ?
       AND phone IN (${placeholders})
     GROUP BY phone`,
    [userId, cutoff, ...phones]
  );

  for (const row of rows) {
    map.set(normalizePhoneForStorage(row.phone), Number(row.last_sent_at || 0));
  }

  return map;
}

async function loadRecentFailureHits(
  db: DBClient,
  userId: number,
  phones: string[],
  now: number
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!phones.length || DISPATCH_RECENT_FAILURE_LIMIT <= 0) return map;

  const cutoff = now - DISPATCH_RECENT_FAILURE_WINDOW_MS;
  const placeholders = buildInClause(phones);
  const rows = await db.all<{ phone: string; total_failures: number }>(
    `SELECT phone, COUNT(*) as total_failures
     FROM dispatch_contact_events
     WHERE user_id = ?
       AND status = 'error'
       AND created_at >= ?
       AND phone IN (${placeholders})
     GROUP BY phone
     HAVING COUNT(*) >= ?`,
    [userId, cutoff, ...phones, DISPATCH_RECENT_FAILURE_LIMIT]
  );

  for (const row of rows) {
    map.set(normalizePhoneForStorage(row.phone), Number(row.total_failures || 0));
  }

  return map;
}

export async function evaluateDispatchSessionHealth(input: {
  userId: number;
  sessionName: string;
  db?: DBClient;
}): Promise<DispatchSessionHealth> {
  const db = resolveDb(input.db);
  const rows = await db.all<{ status: string }>(
    `SELECT status
     FROM dispatch_contact_events
     WHERE user_id = ?
       AND session_name = ?
       AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [
      input.userId,
      input.sessionName,
      Date.now() - SESSION_HEALTH_WINDOW_MS,
      Math.max(DISPATCH_ERROR_RATE_SAMPLE_SIZE, DISPATCH_CONSECUTIVE_FAILURE_LIMIT) * 3,
    ]
  );

  let consecutiveErrors = 0;
  for (const row of rows) {
    if (row.status === "sent") break;
    consecutiveErrors += 1;
  }

  const total = rows.length;
  const errorCount = rows.filter((row) => row.status === "error").length;
  const errorRate = total ? errorCount / total : 0;
  const warnings: string[] = [];

  if (consecutiveErrors >= Math.max(1, DISPATCH_CONSECUTIVE_FAILURE_LIMIT - 1)) {
    warnings.push(
      `A sessão ${input.sessionName} acumula ${consecutiveErrors} falha(s) recente(s).`
    );
  }

  if (
    total >= Math.max(1, DISPATCH_ERROR_RATE_SAMPLE_SIZE - 1) &&
    errorRate >= Math.max(0, DISPATCH_ERROR_RATE_THRESHOLD - 0.1)
  ) {
    warnings.push(
      `A sessão ${input.sessionName} está com taxa de erro recente de ${Math.round(
        errorRate * 100
      )}%.`
    );
  }

  if (consecutiveErrors >= DISPATCH_CONSECUTIVE_FAILURE_LIMIT) {
    return {
      blocked: true,
      reason: `Sessão ${input.sessionName} pausada para campanha: ${consecutiveErrors} falhas consecutivas recentes.`,
      warnings,
      consecutiveErrors,
      total,
      errorRate,
    };
  }

  if (total >= DISPATCH_ERROR_RATE_SAMPLE_SIZE && errorRate >= DISPATCH_ERROR_RATE_THRESHOLD) {
    return {
      blocked: true,
      reason: `Sessão ${input.sessionName} pausada para campanha: taxa de erro recente de ${Math.round(
        errorRate * 100
      )}% nos últimos envios.`,
      warnings,
      consecutiveErrors,
      total,
      errorRate,
    };
  }

  return {
    blocked: false,
    warnings,
    consecutiveErrors,
    total,
    errorRate,
  };
}

export async function evaluateDispatchCampaignRisk(input: {
  userId: number;
  sessionName?: string | null;
  plannedCount: number;
  scheduledAt?: number | null;
  db?: DBClient;
}): Promise<DispatchCampaignRisk> {
  const db = resolveDb(input.db);
  const targetTs = Number(input.scheduledAt || Date.now());
  const plannedCount = Math.max(0, Number(input.plannedCount || 0));
  const warnings: string[] = [];
  const timezoneOffset = await getUserTimezoneOffset(db, input.userId);
  const { start, end } = localDayBoundsFromOffset(targetTs, timezoneOffset);
  const sentToday = await countSentDispatches({
    db,
    userId: input.userId,
    start,
    end,
  });

  if (plannedCount >= DISPATCH_HIGH_RISK_BATCH_THRESHOLD) {
    warnings.push(
      `Disparar ${plannedCount} mensagens na mesma campanha aumenta o risco de bloqueios. Considere dividir em lotes menores.`
    );
  }

  if (sentToday + plannedCount > DISPATCH_DAILY_SAFE_LIMIT) {
    return {
      blocked: true,
      reason: `Limite diario seguro de ${DISPATCH_DAILY_SAFE_LIMIT} mensagens excedido para este dia. Enviadas no periodo: ${sentToday}.`,
      warnings,
      plannedCount,
      sentToday,
      dailySafeLimit: DISPATCH_DAILY_SAFE_LIMIT,
      sessionSentToday: null,
      sessionWarmupDailyLimit: null,
      sessionAgeDays: null,
    };
  }

  const sessionName = String(input.sessionName || "").trim();
  if (!sessionName) {
    return {
      blocked: false,
      warnings,
      plannedCount,
      sentToday,
      dailySafeLimit: DISPATCH_DAILY_SAFE_LIMIT,
      sessionSentToday: null,
      sessionWarmupDailyLimit: null,
      sessionAgeDays: null,
    };
  }

  const createdAtMs = await loadSessionCreatedAtMs(db, input.userId, sessionName);
  if (!createdAtMs) {
    return {
      blocked: false,
      warnings,
      plannedCount,
      sentToday,
      dailySafeLimit: DISPATCH_DAILY_SAFE_LIMIT,
      sessionSentToday: null,
      sessionWarmupDailyLimit: null,
      sessionAgeDays: null,
    };
  }

  const sessionAgeDays = Math.max(0, (targetTs - createdAtMs) / DAY_MS);
  const sessionSentToday = await countSentDispatches({
    db,
    userId: input.userId,
    sessionName,
    start,
    end,
  });

  if (sessionAgeDays < DISPATCH_SESSION_WARMUP_DAYS) {
    warnings.push(
      `Sessao ${sessionName} tem ${Math.floor(sessionAgeDays)} dia(s). Durante os primeiros ${DISPATCH_SESSION_WARMUP_DAYS} dias mantenha volume reduzido.`
    );

    if (plannedCount >= DISPATCH_SESSION_WARMUP_WARNING_THRESHOLD) {
      warnings.push(
        `Campanhas com ${plannedCount} mensagem(ns) sao arriscadas para sessoes em aquecimento.`
      );
    }

    if (sessionSentToday + plannedCount > DISPATCH_SESSION_WARMUP_DAILY_LIMIT) {
      return {
        blocked: true,
        reason: `Sessao ${sessionName} ainda esta em fase de aquecimento (${Math.floor(
          sessionAgeDays
        )} dia(s)). Limite seguro atual: ${DISPATCH_SESSION_WARMUP_DAILY_LIMIT} mensagens/dia; enviadas no periodo: ${sessionSentToday}.`,
        warnings,
        plannedCount,
        sentToday,
        dailySafeLimit: DISPATCH_DAILY_SAFE_LIMIT,
        sessionSentToday,
        sessionWarmupDailyLimit: DISPATCH_SESSION_WARMUP_DAILY_LIMIT,
        sessionAgeDays,
      };
    }
  }

  return {
    blocked: false,
    warnings,
    plannedCount,
    sentToday,
    dailySafeLimit: DISPATCH_DAILY_SAFE_LIMIT,
    sessionSentToday,
    sessionWarmupDailyLimit:
      sessionAgeDays < DISPATCH_SESSION_WARMUP_DAYS
        ? DISPATCH_SESSION_WARMUP_DAILY_LIMIT
        : null,
    sessionAgeDays,
  };
}

export async function evaluateDispatchPolicy(input: {
  userId: number;
  contacts: DispatchTarget[];
  campaignKind: DispatchCampaignKind;
  preferredSession?: string | null;
  scheduledAt?: number | null;
  confirmLargeBatch?: boolean;
  plannedCount?: number;
  db?: DBClient;
  enforceContactCooldown?: boolean;
}): Promise<DispatchPolicyResult> {
  const db = resolveDb(input.db);
  const now = Date.now();
  const scheduledAt = Number(input.scheduledAt || now);
  const timezoneOffset = await getUserTimezoneOffset(db, input.userId);
  const localHour = localHourFromOffset(scheduledAt, timezoneOffset);
  const warnings: string[] = [];
  const skippedContacts: DispatchPolicySkip[] = [];
  const dedupedMap = new Map<string, DispatchTarget>();

  for (const contact of input.contacts) {
    const phone = normalizePhoneForStorage(contact.number);
    if (!phone) continue;

    if (dedupedMap.has(phone)) {
      skippedContacts.push({
        number: phone,
        code: "duplicate_contact",
        reason: "Número duplicado removido da campanha.",
      });
      continue;
    }

    dedupedMap.set(phone, { ...contact, number: phone });
  }

  const dedupedContacts = Array.from(dedupedMap.values());
  const plannedCount = Math.max(
    dedupedContacts.length,
    Number(input.plannedCount || 0)
  );

  if (localHour < DISPATCH_BUSINESS_START_HOUR || localHour >= DISPATCH_BUSINESS_END_HOUR) {
    return {
      allowedContacts: [],
      skippedContacts,
      warnings,
      blocked: true,
      blockReason: `Envios só são permitidos entre ${String(
        DISPATCH_BUSINESS_START_HOUR
      ).padStart(2, "0")}:00 e ${String(DISPATCH_BUSINESS_END_HOUR).padStart(
        2,
        "0"
      )}:00 no fuso horário configurado do usuário.`,
    };
  }

  const campaignRisk = await evaluateDispatchCampaignRisk({
    userId: input.userId,
    sessionName: input.preferredSession?.trim() || null,
    plannedCount,
    scheduledAt,
    db,
  });
  warnings.push(...campaignRisk.warnings);
  if (campaignRisk.blocked) {
    return {
      allowedContacts: [],
      skippedContacts,
      warnings,
      blocked: true,
      blockReason: campaignRisk.reason,
    };
  }

  if (
    input.preferredSession &&
    input.preferredSession.trim() &&
    input.campaignKind === "broadcast"
  ) {
    const sessionHealth = await evaluateDispatchSessionHealth({
      userId: input.userId,
      sessionName: input.preferredSession.trim(),
      db,
    });

    warnings.push(...sessionHealth.warnings);
    if (sessionHealth.blocked) {
      return {
        allowedContacts: [],
        skippedContacts,
        warnings,
        blocked: true,
        blockReason: sessionHealth.reason,
      };
    }
  }

  const phones = dedupedContacts.map((contact) => contact.number);
  const suppressions = await loadSuppressions(db, input.userId, phones);
  const enforceCooldown =
    input.enforceContactCooldown ??
    (!input.scheduledAt || scheduledAt <= now + DISPATCH_CONTACT_COOLDOWN_MS);
  const cooldownHits = enforceCooldown
    ? await loadCooldownHits(db, input.userId, phones, now)
    : new Map<string, number>();
  const recentFailureHits = await loadRecentFailureHits(db, input.userId, phones, now);

  const allowedContacts: DispatchTarget[] = [];
  for (const contact of dedupedContacts) {
    const phone = contact.number;

    if (suppressions.has(phone)) {
      const entry = suppressions.get(phone)!;
      skippedContacts.push({
        number: phone,
        code: "suppressed",
        reason: `Número em lista de supressão (${entry.reason}).`,
      });
      continue;
    }

    if (cooldownHits.has(phone)) {
      skippedContacts.push({
        number: phone,
        code: "cooldown",
        reason: "Número já recebeu envio recente e foi bloqueado pelo cooldown.",
      });
      continue;
    }

    if (recentFailureHits.has(phone)) {
      skippedContacts.push({
        number: phone,
        code: "repeated_failures",
        reason: `Número pulado por histórico recente de falhas (${recentFailureHits.get(
          phone
        )} ocorrências).`,
      });
      continue;
    }

    allowedContacts.push(contact);
  }

  if (skippedContacts.some((item) => item.code === "suppressed")) {
    warnings.push("Contatos em supressão ativa foram removidos da campanha.");
  }
  if (skippedContacts.some((item) => item.code === "cooldown")) {
    warnings.push("Contatos com envio recente foram bloqueados pelo cooldown.");
  }
  if (skippedContacts.some((item) => item.code === "repeated_failures")) {
    warnings.push("Contatos com falhas recorrentes foram bloqueados preventivamente.");
  }
  if (skippedContacts.some((item) => item.code === "duplicate_contact")) {
    warnings.push("Números duplicados foram removidos da campanha.");
  }

  if (
    input.campaignKind === "broadcast" &&
    allowedContacts.length >= DISPATCH_LARGE_BATCH_WARNING_THRESHOLD
  ) {
    warnings.push(
      `Campanha grande detectada (${allowedContacts.length} contatos). Revise a lista antes de enviar.`
    );
    if (!input.confirmLargeBatch) {
      return {
        allowedContacts,
        skippedContacts,
        warnings,
        blocked: false,
        requiresConfirmation: true,
        confirmationMessage: `Confirme manualmente o envio para ${allowedContacts.length} contatos.`,
      };
    }
  }

  if (!allowedContacts.length) {
    return {
      allowedContacts,
      skippedContacts,
      warnings,
      blocked: true,
      blockReason:
        "Nenhum contato elegível restou após aplicar supressão, cooldown e filtros de segurança.",
    };
  }

  return {
    allowedContacts,
    skippedContacts,
    warnings,
    blocked: false,
  };
}

export async function recordDispatchContactEvent(
  input: DispatchContactEventInput,
  db?: DBClient
) {
  const resolvedDb = resolveDb(db);
  const createdAt = Number(input.createdAt || Date.now());
  await resolvedDb.run(
    `INSERT INTO dispatch_contact_events (
      user_id,
      session_name,
      campaign_kind,
      campaign_ref,
      phone,
      status,
      error_code,
      error_message,
      metadata,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.sessionName || null,
      input.campaignKind,
      input.campaignRef || null,
      normalizePhoneForStorage(input.phone),
      input.status,
      input.errorCode || null,
      input.errorMessage || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt,
    ]
  );
}

export async function upsertDispatchSuppression(input: {
  userId: number;
  phone: string;
  reason: string;
  source: string;
  notes?: string | null;
  db?: DBClient;
}) {
  const db = resolveDb(input.db);
  const phone = normalizePhoneForStorage(input.phone);
  const now = Date.now();
  await db.run(
    `INSERT INTO dispatch_suppressions (
      user_id,
      phone,
      status,
      reason,
      source,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = 'active',
      reason = VALUES(reason),
      source = VALUES(source),
      notes = VALUES(notes),
      updated_at = VALUES(updated_at)`,
    [
      input.userId,
      phone,
      input.reason,
      input.source,
      input.notes || null,
      now,
      now,
    ]
  );
}

export async function clearDispatchSuppression(input: {
  userId: number;
  phone: string;
  source: string;
  notes?: string | null;
  db?: DBClient;
}) {
  const db = resolveDb(input.db);
  const phone = normalizePhoneForStorage(input.phone);
  const now = Date.now();
  await db.run(
    `INSERT INTO dispatch_suppressions (
      user_id,
      phone,
      status,
      reason,
      source,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, 'inactive', 'opt_in', ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = 'inactive',
      reason = 'opt_in',
      source = VALUES(source),
      notes = VALUES(notes),
      updated_at = VALUES(updated_at)`,
    [input.userId, phone, input.source, input.notes || null, now, now]
  );
}

export function detectDispatchConsentCommand(text: string): DispatchConsentCommand {
  const normalizedText = normalizeConsentText(text);
  if (!normalizedText || normalizedText.length > 40) return null;

  if (OPT_OUT_EXACT.has(normalizedText)) {
    return { type: "opt_out", normalizedText };
  }

  if (OPT_IN_EXACT.has(normalizedText)) {
    return { type: "opt_in", normalizedText };
  }

  return null;
}

export function classifyDispatchError(error: unknown) {
  const message = String((error as any)?.message || error || "");
  const normalized = message.toLowerCase();

  if (
    normalized.includes("inválido") ||
    normalized.includes("invalido") ||
    normalized.includes("not registered") ||
    normalized.includes("não registrado") ||
    normalized.includes("nao registrado")
  ) {
    return { code: "invalid_number", message };
  }

  if (
    normalized.includes("timeout") ||
    normalized.includes("disconnected") ||
    normalized.includes("reconnect") ||
    normalized.includes("session")
  ) {
    return { code: "session_error", message };
  }

  return { code: "send_error", message };
}
