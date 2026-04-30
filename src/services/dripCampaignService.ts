import { getDB, withDBTransaction, type DBClient } from "../database";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DRIP_MAX_STEPS = Math.max(1, Number(process.env.DRIP_MAX_STEPS || 12));
const DRIP_MAX_DELAY_MS = Math.max(
  DAY_MS,
  Number(process.env.DRIP_MAX_DELAY_MS || 365 * DAY_MS)
);
const DRIP_MONTHLY_LIMIT_NON_PRO = Math.max(
  1,
  Number(process.env.DRIP_MONTHLY_LIMIT_NON_PRO || 500)
);

export const DRIP_TRIGGER_STAGES = [
  "Novo",
  "Qualificando",
  "Negociação",
  "Fechado",
  "Perdido",
] as const;

export type DripTriggerStage = (typeof DRIP_TRIGGER_STAGES)[number];
export type DripEnrollmentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

type DripCampaignRow = {
  id: number;
  user_id: number;
  name: string;
  trigger_stage: string;
  preferred_session: string | null;
  active: number | boolean | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type DripStepRow = {
  id: number;
  campaign_id: number;
  step_order: number;
  delay_ms: number | string;
  message: string | null;
  file: string | null;
  filename: string | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type DripEnrollmentRow = {
  id: number;
  campaign_id: number;
  user_id: number;
  crm_id: number | null;
  contact_name: string | null;
  contact_phone: string;
  current_step: number | string;
  next_send_at: number | string | null;
  status: DripEnrollmentStatus;
  attempt_count: number | string;
  last_attempt_at: number | string | null;
  processing_started_at: number | string | null;
  last_session_name: string | null;
  last_error: string | null;
  completed_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
};

type CampaignStatsRow = {
  campaign_id: number;
  pending: number | string | null;
  processing: number | string | null;
  completed: number | string | null;
  failed: number | string | null;
  cancelled: number | string | null;
};

export type DripPlanAccess = {
  plan: "free" | "starter" | "pro";
  maxMonthlyEnrollments: number | "unlimited";
  monthlyEnrollmentsUsed: number;
  monthlyEnrollmentsRemaining: number | "unlimited";
};

export type DripCampaignStep = {
  id: number | null;
  stepOrder: number;
  delayMs: number;
  message: string;
  file: string | null;
  filename: string | null;
  createdAt: number;
  updatedAt: number;
};

export type DripCampaignStats = {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
};

export type DripCampaignSummary = {
  id: number;
  userId: number;
  name: string;
  triggerStage: DripTriggerStage;
  preferredSession: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  steps: DripCampaignStep[];
  stats: DripCampaignStats;
};

export type DripEnrollmentPreview = {
  id: number;
  campaignId: number;
  crmId: number | null;
  contactName: string | null;
  contactPhone: string;
  currentStep: number;
  nextSendAt: number | null;
  status: DripEnrollmentStatus;
  attemptCount: number;
  lastAttemptAt: number | null;
  processingStartedAt: number | null;
  lastSessionName: string | null;
  lastError: string | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type DripCampaignSaveInput = {
  id?: number | string | null;
  name: string;
  triggerStage: string;
  preferredSession?: string | null;
  active?: boolean | number | string | null;
  steps: Array<{
    id?: number | string | null;
    delayMs?: number | string | null;
    message?: string | null;
    file?: string | null;
    filename?: string | null;
  }>;
};

type DripEnrollmentSyncInput = {
  userId: number;
  userPlan: string | null | undefined;
  crmId: number;
  contactName: string | null | undefined;
  contactPhone: string | null | undefined;
  stage: string | null | undefined;
};

export type DripEnrollmentSyncResult = {
  created: number;
  reset: number;
  skipped: number;
  quotaHit: boolean;
  campaignsTriggered: number;
};

function toSafeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function normalizeBoolean(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "sim"].includes(text)) return true;
  if (["0", "false", "off", "no", "nao", "não"].includes(text)) return false;
  return fallback;
}

function normalizeStageKey(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coerceTriggerStage(value: unknown): DripTriggerStage | null {
  const normalized = normalizeStageKey(value);
  const match = DRIP_TRIGGER_STAGES.find(
    (stage) => normalizeStageKey(stage) === normalized
  );
  return match || null;
}

function clipText(value: unknown, max: number) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 30);
}

function getMonthWindow(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
  return { start, end };
}

export function getDripPlanAccess(
  plan: string | null | undefined,
  monthlyUsed = 0
): DripPlanAccess {
  const normalized =
    String(plan || "").trim().toLowerCase() === "pro"
      ? "pro"
      : String(plan || "").trim().toLowerCase() === "starter"
        ? "starter"
        : "free";

  if (normalized === "pro") {
    return {
      plan: normalized,
      maxMonthlyEnrollments: "unlimited",
      monthlyEnrollmentsUsed: monthlyUsed,
      monthlyEnrollmentsRemaining: "unlimited",
    };
  }

  return {
    plan: normalized,
    maxMonthlyEnrollments: DRIP_MONTHLY_LIMIT_NON_PRO,
    monthlyEnrollmentsUsed: monthlyUsed,
    monthlyEnrollmentsRemaining: Math.max(
      0,
      DRIP_MONTHLY_LIMIT_NON_PRO - monthlyUsed
    ),
  };
}

function normalizeStepInput(
  step: DripCampaignSaveInput["steps"][number],
  stepOrder: number
) {
  const delayMs = Math.max(
    0,
    Math.min(DRIP_MAX_DELAY_MS, toSafeInt(step?.delayMs, 0))
  );
  const message = String(step?.message || "").trim();
  const file = step?.file ? String(step.file) : null;
  const filename = step?.filename ? clipText(step.filename, 255) : null;

  if (!message && !file) {
    throw new Error(`A etapa ${stepOrder + 1} precisa de mensagem ou mídia.`);
  }

  return {
    id: step?.id ? toSafeInt(step.id, 0) : 0,
    stepOrder,
    delayMs,
    message,
    file,
    filename,
  };
}

function emptyCampaignStats(): DripCampaignStats {
  return {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    active: 0,
  };
}

function hydrateStep(row: DripStepRow): DripCampaignStep {
  return {
    id: toSafeInt(row.id) || null,
    stepOrder: toSafeInt(row.step_order),
    delayMs: Math.max(0, toSafeInt(row.delay_ms)),
    message: String(row.message || ""),
    file: row.file ? String(row.file) : null,
    filename: row.filename ? String(row.filename) : null,
    createdAt: toSafeInt(row.created_at),
    updatedAt: toSafeInt(row.updated_at),
  };
}

function hydrateEnrollment(row: DripEnrollmentRow): DripEnrollmentPreview {
  return {
    id: toSafeInt(row.id),
    campaignId: toSafeInt(row.campaign_id),
    crmId: row.crm_id == null ? null : toSafeInt(row.crm_id),
    contactName: row.contact_name ? String(row.contact_name) : null,
    contactPhone: normalizePhone(row.contact_phone),
    currentStep: toSafeInt(row.current_step),
    nextSendAt: row.next_send_at == null ? null : toSafeInt(row.next_send_at),
    status: row.status,
    attemptCount: toSafeInt(row.attempt_count),
    lastAttemptAt:
      row.last_attempt_at == null ? null : toSafeInt(row.last_attempt_at),
    processingStartedAt:
      row.processing_started_at == null
        ? null
        : toSafeInt(row.processing_started_at),
    lastSessionName: row.last_session_name ? String(row.last_session_name) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    completedAt: row.completed_at == null ? null : toSafeInt(row.completed_at),
    createdAt: toSafeInt(row.created_at),
    updatedAt: toSafeInt(row.updated_at),
  };
}

async function countMonthlyEnrollmentsCreated(
  db: DBClient,
  userId: number,
  timestamp = Date.now()
) {
  const { start, end } = getMonthWindow(timestamp);
  const row = await db.get<{ total: number | string | null }>(
    `
    SELECT COUNT(*) AS total
    FROM drip_enrollments
    WHERE user_id = ?
      AND created_at >= ?
      AND created_at < ?
    `,
    [userId, start, end]
  );

  return toSafeInt(row?.total, 0);
}

export async function listDripCampaignsForUser(params: {
  userId: number;
  userPlan?: string | null | undefined;
}) {
  const db = getDB();
  const [campaignRows, stepRows, statsRows, monthlyUsed] = await Promise.all([
    db.all<DripCampaignRow>(
      `
      SELECT *
      FROM drip_campaigns
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
      `,
      [params.userId]
    ),
    db.all<DripStepRow>(
      `
      SELECT s.*
      FROM drip_steps s
      INNER JOIN drip_campaigns c ON c.id = s.campaign_id
      WHERE c.user_id = ?
      ORDER BY s.campaign_id ASC, s.step_order ASC, s.id ASC
      `,
      [params.userId]
    ),
    db.all<CampaignStatsRow>(
      `
      SELECT
        campaign_id,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM drip_enrollments
      WHERE user_id = ?
      GROUP BY campaign_id
      `,
      [params.userId]
    ),
    countMonthlyEnrollmentsCreated(db, params.userId),
  ]);

  const stepsByCampaign = new Map<number, DripCampaignStep[]>();
  for (const row of stepRows) {
    const key = toSafeInt(row.campaign_id);
    const current = stepsByCampaign.get(key) || [];
    current.push(hydrateStep(row));
    stepsByCampaign.set(key, current);
  }

  const statsByCampaign = new Map<number, DripCampaignStats>();
  for (const row of statsRows) {
    const stats: DripCampaignStats = {
      pending: toSafeInt(row.pending),
      processing: toSafeInt(row.processing),
      completed: toSafeInt(row.completed),
      failed: toSafeInt(row.failed),
      cancelled: toSafeInt(row.cancelled),
      active: toSafeInt(row.pending) + toSafeInt(row.processing),
    };
    statsByCampaign.set(toSafeInt(row.campaign_id), stats);
  }

  const campaigns: DripCampaignSummary[] = campaignRows.map((row) => ({
    id: toSafeInt(row.id),
    userId: toSafeInt(row.user_id),
    name: String(row.name || ""),
    triggerStage:
      coerceTriggerStage(row.trigger_stage) || DRIP_TRIGGER_STAGES[0],
    preferredSession: row.preferred_session
      ? String(row.preferred_session)
      : null,
    active: normalizeBoolean(row.active, true),
    createdAt: toSafeInt(row.created_at),
    updatedAt: toSafeInt(row.updated_at),
    steps: stepsByCampaign.get(toSafeInt(row.id)) || [],
    stats: statsByCampaign.get(toSafeInt(row.id)) || emptyCampaignStats(),
  }));

  return {
    campaigns,
    access: getDripPlanAccess(params.userPlan, monthlyUsed),
  };
}

export async function listDripEnrollmentsForCampaign(params: {
  userId: number;
  campaignId: number;
  limit?: number;
}) {
  const db = getDB();
  const limit = Math.max(1, Math.min(100, toSafeInt(params.limit, 25)));
  const rows = await db.all<DripEnrollmentRow>(
    `
    SELECT de.*
    FROM drip_enrollments de
    INNER JOIN drip_campaigns dc
      ON dc.id = de.campaign_id
    WHERE de.user_id = ?
      AND de.campaign_id = ?
      AND dc.user_id = ?
    ORDER BY
      CASE de.status
        WHEN 'processing' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'failed' THEN 2
        WHEN 'completed' THEN 3
        ELSE 4
      END ASC,
      COALESCE(de.next_send_at, de.updated_at) ASC,
      de.id DESC
    LIMIT ?
    `,
    [params.userId, params.campaignId, params.userId, limit]
  );

  return rows.map((row) => hydrateEnrollment(row));
}

export async function saveDripCampaign(params: {
  userId: number;
  input: DripCampaignSaveInput;
}) {
  const safeId = toSafeInt(params.input.id, 0);
  const name = clipText(params.input.name, 120);
  const triggerStage = coerceTriggerStage(params.input.triggerStage);
  const preferredSession = clipText(params.input.preferredSession, 255) || null;
  const active = normalizeBoolean(params.input.active, true);
  const rawSteps = Array.isArray(params.input.steps) ? params.input.steps : [];

  if (!name) {
    throw new Error("Informe o nome da campanha drip.");
  }

  if (!triggerStage) {
    throw new Error("Selecione um estágio de gatilho válido.");
  }

  if (!rawSteps.length) {
    throw new Error("Adicione pelo menos uma etapa na sequência.");
  }

  if (rawSteps.length > DRIP_MAX_STEPS) {
    throw new Error(`A campanha suporta no máximo ${DRIP_MAX_STEPS} etapas.`);
  }

  const steps = rawSteps.map((step, index) => normalizeStepInput(step, index));
  const now = Date.now();

  const campaignId = await withDBTransaction<number>(async (db) => {
    if (safeId) {
      const existing = await db.get<{ id: number }>(
        `SELECT id FROM drip_campaigns WHERE id = ? AND user_id = ? LIMIT 1`,
        [safeId, params.userId]
      );
      if (!existing?.id) {
        throw new Error("Campanha drip não encontrada.");
      }

      await db.run(
        `
        UPDATE drip_campaigns
        SET name = ?,
            trigger_stage = ?,
            preferred_session = ?,
            active = ?,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
        `,
        [
          name,
          triggerStage,
          preferredSession,
          active ? 1 : 0,
          now,
          safeId,
          params.userId,
        ]
      );

      await db.run(`DELETE FROM drip_steps WHERE campaign_id = ?`, [safeId]);
    } else {
      const result = await db.run(
        `
        INSERT INTO drip_campaigns (
          user_id,
          name,
          trigger_stage,
          preferred_session,
          active,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          params.userId,
          name,
          triggerStage,
          preferredSession,
          active ? 1 : 0,
          now,
          now,
        ]
      );

      const insertedId = Number((result as any)?.insertId || 0);
      if (!insertedId) {
        throw new Error("Não foi possível criar a campanha drip.");
      }
      return insertedId;
    }

    return safeId;
  });

  await withDBTransaction(async (db) => {
    const valuesSql = steps.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const paramsList = steps.flatMap((step) => [
      campaignId,
      step.stepOrder,
      step.delayMs,
      step.message || null,
      step.file,
      step.filename,
      now,
    ]);

    await db.run(
      `
      INSERT INTO drip_steps (
        campaign_id,
        step_order,
        delay_ms,
        message,
        file,
        filename,
        created_at,
        updated_at
      ) VALUES ${valuesSql.replace(/\(\?, \?, \?, \?, \?, \?, \?\)/g, "(?, ?, ?, ?, ?, ?, ?, ?)")}
      `,
      steps.flatMap((step) => [
        campaignId,
        step.stepOrder,
        step.delayMs,
        step.message || null,
        step.file,
        step.filename,
        now,
        now,
      ])
    );
  });

  const result = await listDripCampaignsForUser({ userId: params.userId });
  const saved = result.campaigns.find((campaign) => campaign.id === campaignId);
  if (!saved) {
    throw new Error("Não foi possível carregar a campanha após salvar.");
  }
  return saved;
}

export async function deleteDripCampaign(params: {
  userId: number;
  campaignId: number;
}) {
  const db = getDB();
  const result = await db.run(
    `DELETE FROM drip_campaigns WHERE id = ? AND user_id = ?`,
    [params.campaignId, params.userId]
  );

  if (!result.affectedRows) {
    throw new Error("Campanha drip não encontrada.");
  }
}

export async function updateDripEnrollmentContactSnapshot(params: {
  userId: number;
  crmId: number;
  contactName?: string | null | undefined;
  contactPhone?: string | null | undefined;
}) {
  const userId = toSafeInt(params.userId, 0);
  const crmId = toSafeInt(params.crmId, 0);
  const phone = normalizePhone(params.contactPhone);

  if (!userId || !crmId || !phone) return;

  const db = getDB();
  await db.run(
    `
    UPDATE drip_enrollments
    SET contact_name = ?,
        contact_phone = ?,
        updated_at = ?
    WHERE user_id = ?
      AND crm_id = ?
    `,
    [
      clipText(params.contactName, 255) || null,
      phone,
      Date.now(),
      userId,
      crmId,
    ]
  );
}

export async function syncDripEnrollmentsForCrmStage(
  input: DripEnrollmentSyncInput
): Promise<DripEnrollmentSyncResult> {
  const stage = coerceTriggerStage(input.stage);
  const phone = normalizePhone(input.contactPhone);
  const contactName = clipText(input.contactName, 255) || null;

  if (!stage || !phone || !input.crmId || !input.userId) {
    return {
      created: 0,
      reset: 0,
      skipped: 0,
      quotaHit: false,
      campaignsTriggered: 0,
    };
  }

  const db = getDB();
  const campaignRows = await db.all<DripCampaignRow>(
    `
    SELECT *
    FROM drip_campaigns
    WHERE user_id = ?
      AND active = 1
    ORDER BY id ASC
    `,
    [input.userId]
  );

  const matchingCampaigns = campaignRows.filter(
    (campaign) =>
      normalizeStageKey(campaign.trigger_stage) === normalizeStageKey(stage)
  );

  if (!matchingCampaigns.length) {
    return {
      created: 0,
      reset: 0,
      skipped: 0,
      quotaHit: false,
      campaignsTriggered: 0,
    };
  }

  const campaignIds = matchingCampaigns.map((campaign) => toSafeInt(campaign.id));
  const placeholders = campaignIds.map(() => "?").join(", ");
  const [stepRows, existingRows, monthlyUsed] = await Promise.all([
    db.all<DripStepRow>(
      `
      SELECT *
      FROM drip_steps
      WHERE campaign_id IN (${placeholders})
      ORDER BY campaign_id ASC, step_order ASC, id ASC
      `,
      campaignIds
    ),
    db.all<DripEnrollmentRow>(
      `
      SELECT *
      FROM drip_enrollments
      WHERE user_id = ?
        AND crm_id = ?
        AND campaign_id IN (${placeholders})
      `,
      [input.userId, input.crmId, ...campaignIds]
    ),
    countMonthlyEnrollmentsCreated(db, input.userId),
  ]);

  const access = getDripPlanAccess(input.userPlan, monthlyUsed);
  let remainingMonthly =
    access.maxMonthlyEnrollments === "unlimited"
      ? Number.POSITIVE_INFINITY
      : Math.max(0, access.maxMonthlyEnrollments - monthlyUsed);

  const firstStepByCampaign = new Map<number, DripStepRow>();
  for (const row of stepRows) {
    const campaignId = toSafeInt(row.campaign_id);
    if (!firstStepByCampaign.has(campaignId)) {
      firstStepByCampaign.set(campaignId, row);
    }
  }

  const existingByCampaign = new Map<number, DripEnrollmentRow>();
  for (const row of existingRows) {
    existingByCampaign.set(toSafeInt(row.campaign_id), row);
  }

  const now = Date.now();
  let created = 0;
  let reset = 0;
  let skipped = 0;
  let quotaHit = false;

  await withDBTransaction(async (tx) => {
    for (const campaign of matchingCampaigns) {
      const campaignId = toSafeInt(campaign.id);
      const firstStep = firstStepByCampaign.get(campaignId);
      if (!firstStep) {
        skipped += 1;
        continue;
      }

      const nextSendAt = now + Math.max(0, toSafeInt(firstStep.delay_ms));
      const existing = existingByCampaign.get(campaignId);

      if (existing?.id) {
        await tx.run(
          `
          UPDATE drip_enrollments
          SET crm_id = ?,
              contact_name = ?,
              contact_phone = ?,
              current_step = 0,
              next_send_at = ?,
              status = 'pending',
              attempt_count = 0,
              last_attempt_at = NULL,
              processing_started_at = NULL,
              last_session_name = NULL,
              last_error = NULL,
              completed_at = NULL,
              updated_at = ?
          WHERE id = ?
            AND user_id = ?
          `,
          [
            input.crmId,
            contactName,
            phone,
            nextSendAt,
            now,
            existing.id,
            input.userId,
          ]
        );
        reset += 1;
        continue;
      }

      if (remainingMonthly <= 0) {
        quotaHit = true;
        skipped += 1;
        continue;
      }

      await tx.run(
        `
        INSERT INTO drip_enrollments (
          campaign_id,
          user_id,
          crm_id,
          contact_name,
          contact_phone,
          current_step,
          next_send_at,
          status,
          attempt_count,
          last_attempt_at,
          processing_started_at,
          last_session_name,
          last_error,
          completed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `,
        [
          campaignId,
          input.userId,
          input.crmId,
          contactName,
          phone,
          nextSendAt,
          now,
          now,
        ]
      );
      created += 1;
      remainingMonthly -= 1;
    }
  });

  return {
    created,
    reset,
    skipped,
    quotaHit,
    campaignsTriggered: matchingCampaigns.length,
  };
}
