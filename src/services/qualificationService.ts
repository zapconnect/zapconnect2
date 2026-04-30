import { getDB, withDBTransaction, type DBClient } from "../database";
import { syncDripEnrollmentsForCrmStage } from "./dripCampaignService";

const QUALIFICATION_MAX_STEPS = Math.max(
  1,
  Number(process.env.QUALIFICATION_MAX_STEPS || 10)
);
const QUALIFICATION_NON_PRO_ACTIVE_LIMIT = Math.max(
  1,
  Number(process.env.QUALIFICATION_NON_PRO_ACTIVE_LIMIT || 1)
);

export const QUALIFICATION_STEP_TYPES = ["text", "number", "options"] as const;
export const QUALIFICATION_SAVE_FIELDS = [
  "none",
  "name",
  "interest",
  "budget",
  "urgency",
  "citystate",
  "notes",
] as const;
export const QUALIFICATION_CRM_STAGES = [
  "Novo",
  "Qualificando",
  "Negociacao",
  "Fechado",
  "Perdido",
] as const;

export type QualificationStepType = (typeof QUALIFICATION_STEP_TYPES)[number];
export type QualificationSaveField = (typeof QUALIFICATION_SAVE_FIELDS)[number];
export type QualificationCrmStage = (typeof QUALIFICATION_CRM_STAGES)[number];
export type QualificationSessionStatus = "active" | "completed" | "cancelled";

type QualificationFlowRow = {
  id: number;
  user_id: number;
  name: string;
  trigger_keywords: string | null;
  steps: string;
  settings: string | null;
  active: number | boolean | null;
  created_at: number | string | null;
  updated_at: number | string | null;
};

type QualificationSessionRow = {
  id: number;
  user_id: number;
  flow_id: number;
  crm_id: number | null;
  session_name: string | null;
  chat_id: string;
  contact_phone: string;
  contact_name: string | null;
  current_step: number | string;
  answers: string | null;
  status: QualificationSessionStatus;
  score: number | string | null;
  last_question_at: number | string | null;
  last_answer_at: number | string | null;
  started_at: number | string;
  completed_at: number | string | null;
  updated_at: number | string;
};

type QualificationStatsRow = {
  flow_id: number;
  active_sessions: number | string | null;
  completed_sessions: number | string | null;
  cancelled_sessions: number | string | null;
  average_score: number | string | null;
};

type QualificationFlowLoadedRow = QualificationFlowRow & {
  session_id?: number;
  session_status?: QualificationSessionStatus;
  session_current_step?: number | string | null;
  session_answers?: string | null;
  session_contact_name?: string | null;
  session_contact_phone?: string | null;
  session_score?: number | string | null;
};

export type QualificationPlanAccess = {
  plan: "free" | "starter" | "pro";
  maxActiveFlows: number | "unlimited";
  activeFlowsUsed: number;
  activeFlowsRemaining: number | "unlimited";
};

export type QualificationFlowOption = {
  id: string;
  label: string;
  value: string;
  score: number;
};

export type QualificationFlowStep = {
  id: string;
  question: string;
  type: QualificationStepType;
  field: QualificationSaveField;
  required: boolean;
  placeholder: string;
  helperText: string;
  baseScore: number;
  options: QualificationFlowOption[];
};

export type QualificationFlowSettings = {
  warmThreshold: number;
  hotThreshold: number;
  coldStage: QualificationCrmStage;
  warmStage: QualificationCrmStage;
  hotStage: QualificationCrmStage;
  completionMessage: string;
  introMessage: string;
};

export type QualificationFlowSummary = {
  id: number;
  userId: number;
  name: string;
  triggerKeywords: string[];
  active: boolean;
  createdAt: number;
  updatedAt: number;
  steps: QualificationFlowStep[];
  settings: QualificationFlowSettings;
  stats: {
    activeSessions: number;
    completedSessions: number;
    cancelledSessions: number;
    averageScore: number | null;
  };
};

export type QualificationAnswerRecord = {
  stepId: string;
  question: string;
  type: QualificationStepType;
  field: QualificationSaveField;
  rawAnswer: string;
  normalizedValue: string | number;
  score: number;
  answeredAt: number;
};

export type QualificationSessionPreview = {
  id: number;
  flowId: number;
  crmId: number | null;
  chatId: string;
  contactPhone: string;
  contactName: string | null;
  currentStep: number;
  status: QualificationSessionStatus;
  score: number | null;
  answers: QualificationAnswerRecord[];
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
};

export type QualificationFlowSaveInput = {
  id?: number | string | null;
  name: string;
  triggerKeywords?: string[] | string | null;
  active?: boolean | number | string | null;
  steps: Array<{
    id?: string | null;
    question?: string | null;
    type?: string | null;
    field?: string | null;
    required?: boolean | number | string | null;
    placeholder?: string | null;
    helperText?: string | null;
    baseScore?: number | string | null;
    options?: Array<{
      id?: string | null;
      label?: string | null;
      value?: string | null;
      score?: number | string | null;
    }>;
  }>;
  settings?: Partial<QualificationFlowSettings> | null;
};

type QualificationFlowSaveOptionInput = NonNullable<
  QualificationFlowSaveInput["steps"][number]["options"]
>[number];

export type QualificationRuntimeInput = {
  userId: number;
  sessionName: string;
  chatId: string;
  crmId?: number | null;
  contactPhone: string;
  contactName?: string | null;
  messageBody: string;
  crmStage?: string | null;
};

export type QualificationRuntimeResult = {
  handled: boolean;
  responseText?: string;
  started?: boolean;
  completed?: boolean;
  flowId?: number | null;
  sessionId?: number | null;
  score?: number | null;
};

function toSafeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function toSafeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBoolean(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "sim"].includes(text)) return true;
  if (["0", "false", "off", "no", "nao", "não"].includes(text)) return false;
  return fallback;
}

function clipText(value: unknown, max: number) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 30);
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") {
    return value as T;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function slugToken(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeStageKey(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coerceCrmStage(value: unknown): QualificationCrmStage {
  const normalized = normalizeStageKey(value);
  const match = QUALIFICATION_CRM_STAGES.find(
    (stage) => normalizeStageKey(stage) === normalized
  );
  return match || "Novo";
}

function formatStageLabel(stage: QualificationCrmStage) {
  if (stage === "Negociacao") return "Negociação";
  return stage;
}

function normalizeTriggerKeywords(value: unknown) {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => clipText(item, 60))
          .filter(Boolean)
          .map((item) => item.toLowerCase())
      )
    );
  }

  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((item) => clipText(item, 60))
        .filter(Boolean)
        .map((item) => item.toLowerCase())
    )
  );
}

function defaultFlowSettings(): QualificationFlowSettings {
  return {
    warmThreshold: 40,
    hotThreshold: 70,
    coldStage: "Novo",
    warmStage: "Qualificando",
    hotStage: "Negociacao",
    completionMessage:
      "Perfeito! Ja organizei suas respostas e vou seguir com o atendimento por aqui.",
    introMessage:
      "Vou te fazer algumas perguntas rapidas para direcionar melhor seu atendimento.",
  };
}

function normalizeFlowSettings(
  input: Partial<QualificationFlowSettings> | null | undefined
): QualificationFlowSettings {
  const defaults = defaultFlowSettings();
  const warmThreshold = Math.max(
    0,
    Math.min(100, toSafeInt(input?.warmThreshold, defaults.warmThreshold))
  );
  const hotThreshold = Math.max(
    warmThreshold,
    Math.min(100, toSafeInt(input?.hotThreshold, defaults.hotThreshold))
  );

  return {
    warmThreshold,
    hotThreshold,
    coldStage: coerceCrmStage(input?.coldStage || defaults.coldStage),
    warmStage: coerceCrmStage(input?.warmStage || defaults.warmStage),
    hotStage: coerceCrmStage(input?.hotStage || defaults.hotStage),
    completionMessage:
      clipText(input?.completionMessage, 500) || defaults.completionMessage,
    introMessage: clipText(input?.introMessage, 500) || defaults.introMessage,
  };
}

function normalizeOptionInput(
  option: QualificationFlowSaveOptionInput,
  stepIndex: number,
  optionIndex: number
): QualificationFlowOption {
  const label = clipText(option?.label, 120);
  const value = clipText(option?.value, 120) || label;
  if (!label) {
    throw new Error(
      `A opcao ${optionIndex + 1} da pergunta ${stepIndex + 1} precisa de um texto.`
    );
  }

  return {
    id:
      clipText(option?.id, 64) || `opt-${stepIndex + 1}-${optionIndex + 1}-${slugToken(label)}`,
    label,
    value,
    score: Math.max(0, Math.min(100, toSafeInt(option?.score, 0))),
  };
}

function normalizeStepInput(
  step: QualificationFlowSaveInput["steps"][number],
  stepIndex: number
): QualificationFlowStep {
  const question = clipText(step?.question, 500);
  const type = QUALIFICATION_STEP_TYPES.includes(
    String(step?.type || "") as QualificationStepType
  )
    ? (String(step?.type) as QualificationStepType)
    : "text";
  const field = QUALIFICATION_SAVE_FIELDS.includes(
    String(step?.field || "") as QualificationSaveField
  )
    ? (String(step?.field) as QualificationSaveField)
    : "none";

  if (!question) {
    throw new Error(`A pergunta ${stepIndex + 1} precisa de um texto.`);
  }

  const options = Array.isArray(step?.options)
    ? step.options
        .map((option, optionIndex) =>
          normalizeOptionInput(option, stepIndex, optionIndex)
        )
        .filter(Boolean)
    : [];

  if (type === "options" && options.length < 2) {
    throw new Error(
      `A pergunta ${stepIndex + 1} precisa de pelo menos duas opcoes.`
    );
  }

  return {
    id:
      clipText(step?.id, 64) ||
      `step-${stepIndex + 1}-${slugToken(question).slice(0, 24) || "pergunta"}`,
    question,
    type,
    field,
    required: normalizeBoolean(step?.required, true),
    placeholder: clipText(step?.placeholder, 180),
    helperText: clipText(step?.helperText, 240),
    baseScore: Math.max(0, Math.min(100, toSafeInt(step?.baseScore, 0))),
    options,
  };
}

function hydrateFlowSteps(value: unknown) {
  const raw = safeJsonParse<any[]>(value, []);
  return raw.map((step, index) => normalizeStepInput(step, index));
}

function hydrateFlowSettings(value: unknown) {
  return normalizeFlowSettings(safeJsonParse(value, {}));
}

function hydrateAnswers(value: unknown) {
  return safeJsonParse<QualificationAnswerRecord[]>(value, []);
}

function hydrateSession(row: QualificationSessionRow): QualificationSessionPreview {
  return {
    id: toSafeInt(row.id),
    flowId: toSafeInt(row.flow_id),
    crmId: row.crm_id == null ? null : toSafeInt(row.crm_id),
    chatId: String(row.chat_id || ""),
    contactPhone: normalizePhone(row.contact_phone),
    contactName: row.contact_name ? String(row.contact_name) : null,
    currentStep: Math.max(0, toSafeInt(row.current_step)),
    status: row.status,
    score: row.score == null ? null : toSafeInt(row.score),
    answers: hydrateAnswers(row.answers),
    startedAt: toSafeInt(row.started_at),
    completedAt: row.completed_at == null ? null : toSafeInt(row.completed_at),
    updatedAt: toSafeInt(row.updated_at),
  };
}

function hydrateFlowSummary(
  row: QualificationFlowRow,
  stats?: QualificationStatsRow | null
): QualificationFlowSummary {
  return {
    id: toSafeInt(row.id),
    userId: toSafeInt(row.user_id),
    name: String(row.name || ""),
    triggerKeywords: normalizeTriggerKeywords(
      safeJsonParse<string[]>(row.trigger_keywords, [])
    ),
    active: normalizeBoolean(row.active, true),
    createdAt: toSafeInt(row.created_at),
    updatedAt: toSafeInt(row.updated_at),
    steps: hydrateFlowSteps(row.steps),
    settings: hydrateFlowSettings(row.settings),
    stats: {
      activeSessions: toSafeInt(stats?.active_sessions, 0),
      completedSessions: toSafeInt(stats?.completed_sessions, 0),
      cancelledSessions: toSafeInt(stats?.cancelled_sessions, 0),
      averageScore:
        stats?.average_score == null ? null : Math.round(toSafeNumber(stats.average_score, 0)),
    },
  };
}

export function getQualificationPlanAccess(
  plan: string | null | undefined,
  activeFlowsUsed = 0
): QualificationPlanAccess {
  const normalized =
    String(plan || "").trim().toLowerCase() === "pro"
      ? "pro"
      : String(plan || "").trim().toLowerCase() === "starter"
        ? "starter"
        : "free";

  if (normalized === "pro") {
    return {
      plan: normalized,
      maxActiveFlows: "unlimited",
      activeFlowsUsed,
      activeFlowsRemaining: "unlimited",
    };
  }

  return {
    plan: normalized,
    maxActiveFlows: QUALIFICATION_NON_PRO_ACTIVE_LIMIT,
    activeFlowsUsed,
    activeFlowsRemaining: Math.max(
      0,
      QUALIFICATION_NON_PRO_ACTIVE_LIMIT - activeFlowsUsed
    ),
  };
}

export async function listQualificationFlowsForUser(params: {
  userId: number;
  userPlan?: string | null | undefined;
}) {
  const db = getDB();
  const [flowRows, statsRows] = await Promise.all([
    db.all<QualificationFlowRow>(
      `
      SELECT *
      FROM qualification_flows
      WHERE user_id = ?
      ORDER BY active DESC, updated_at DESC, id DESC
      `,
      [params.userId]
    ),
    db.all<QualificationStatsRow>(
      `
      SELECT
        flow_id,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_sessions,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_sessions,
        AVG(CASE WHEN status = 'completed' THEN score END) AS average_score
      FROM qualification_sessions
      WHERE user_id = ?
      GROUP BY flow_id
      `,
      [params.userId]
    ),
  ]);

  const statsByFlowId = new Map<number, QualificationStatsRow>();
  for (const row of statsRows) {
    statsByFlowId.set(toSafeInt(row.flow_id), row);
  }

  const activeFlowsUsed = flowRows.filter((row) => normalizeBoolean(row.active, true))
    .length;

  return {
    flows: flowRows.map((row) =>
      hydrateFlowSummary(row, statsByFlowId.get(toSafeInt(row.id)) || null)
    ),
    access: getQualificationPlanAccess(params.userPlan, activeFlowsUsed),
  };
}

export async function listQualificationSessionsForFlow(params: {
  userId: number;
  flowId: number;
  limit?: number;
}) {
  const db = getDB();
  const limit = Math.max(1, Math.min(50, toSafeInt(params.limit, 20)));
  const rows = await db.all<QualificationSessionRow>(
    `
    SELECT qs.*
    FROM qualification_sessions qs
    INNER JOIN qualification_flows qf
      ON qf.id = qs.flow_id
    WHERE qs.user_id = ?
      AND qs.flow_id = ?
      AND qf.user_id = ?
    ORDER BY qs.updated_at DESC, qs.id DESC
    LIMIT ?
    `,
    [params.userId, params.flowId, params.userId, limit]
  );

  return rows.map((row) => hydrateSession(row));
}

export async function saveQualificationFlow(params: {
  userId: number;
  userPlan?: string | null | undefined;
  input: QualificationFlowSaveInput;
}) {
  const safeId = toSafeInt(params.input.id, 0);
  const name = clipText(params.input.name, 120);
  const triggerKeywords = normalizeTriggerKeywords(params.input.triggerKeywords);
  const active = normalizeBoolean(params.input.active, true);
  const rawSteps = Array.isArray(params.input.steps) ? params.input.steps : [];
  const settings = normalizeFlowSettings(params.input.settings);

  if (!name) {
    throw new Error("Informe o nome do questionario.");
  }

  if (!rawSteps.length) {
    throw new Error("Adicione pelo menos uma pergunta ao fluxo.");
  }

  if (rawSteps.length > QUALIFICATION_MAX_STEPS) {
    throw new Error(
      `O fluxo suporta no maximo ${QUALIFICATION_MAX_STEPS} perguntas.`
    );
  }

  const steps = rawSteps.map((step, index) => normalizeStepInput(step, index));
  const now = Date.now();

  const flowId = await withDBTransaction<number>(async (db) => {
    if (active) {
      const activeRow = await db.get<{ total: number | string | null }>(
        `
        SELECT COUNT(*) AS total
        FROM qualification_flows
        WHERE user_id = ?
          AND active = 1
          AND id <> ?
        `,
        [params.userId, safeId || 0]
      );

      const access = getQualificationPlanAccess(
        params.userPlan,
        toSafeInt(activeRow?.total, 0)
      );
      if (
        access.maxActiveFlows !== "unlimited" &&
        toSafeInt(activeRow?.total, 0) >= access.maxActiveFlows
      ) {
        throw new Error(
          "Seu plano permite apenas um fluxo de qualificacao ativo por vez."
        );
      }
    }

    if (safeId) {
      const existing = await db.get<{ id: number }>(
        `SELECT id FROM qualification_flows WHERE id = ? AND user_id = ? LIMIT 1`,
        [safeId, params.userId]
      );
      if (!existing?.id) {
        throw new Error("Fluxo de qualificacao nao encontrado.");
      }

      await db.run(
        `
        UPDATE qualification_flows
        SET name = ?,
            trigger_keywords = ?,
            steps = ?,
            settings = ?,
            active = ?,
            updated_at = ?
        WHERE id = ?
          AND user_id = ?
        `,
        [
          name,
          JSON.stringify(triggerKeywords),
          JSON.stringify(steps),
          JSON.stringify(settings),
          active ? 1 : 0,
          now,
          safeId,
          params.userId,
        ]
      );

      return safeId;
    }

    const result = await db.run(
      `
      INSERT INTO qualification_flows (
        user_id,
        name,
        trigger_keywords,
        steps,
        settings,
        active,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        params.userId,
        name,
        JSON.stringify(triggerKeywords),
        JSON.stringify(steps),
        JSON.stringify(settings),
        active ? 1 : 0,
        now,
        now,
      ]
    );

    const insertedId = Number((result as any)?.insertId || 0);
    if (!insertedId) {
      throw new Error("Nao foi possivel criar o fluxo de qualificacao.");
    }

    return insertedId;
  });

  const result = await listQualificationFlowsForUser({
    userId: params.userId,
    userPlan: params.userPlan,
  });
  const saved = result.flows.find((flow) => flow.id === flowId);
  if (!saved) {
    throw new Error("Nao foi possivel carregar o fluxo apos salvar.");
  }
  return saved;
}

export async function deleteQualificationFlow(params: {
  userId: number;
  flowId: number;
}) {
  const db = getDB();
  const result = await db.run(
    `DELETE FROM qualification_flows WHERE id = ? AND user_id = ?`,
    [params.flowId, params.userId]
  );

  if (!result.affectedRows) {
    throw new Error("Fluxo de qualificacao nao encontrado.");
  }
}

function buildQuestionPrompt(
  flow: QualificationFlowSummary,
  step: QualificationFlowStep,
  stepIndex: number,
  options?: {
    invalidReason?: string | null;
    includeIntro?: boolean;
  }
) {
  const lines: string[] = [];

  if (options?.invalidReason) {
    lines.push(String(options.invalidReason));
  } else if (options?.includeIntro) {
    lines.push(flow.settings.introMessage);
  }

  lines.push(`Pergunta ${stepIndex + 1}/${flow.steps.length}: ${step.question}`);

  if (step.type === "options" && step.options.length) {
    lines.push(
      step.options
        .map((option, index) => `${index + 1}. ${option.label}`)
        .join("\n")
    );
  } else if (step.helperText) {
    lines.push(step.helperText);
  } else if (step.type === "number") {
    lines.push("Responda apenas com numeros ou valor aproximado.");
  }

  return lines.filter(Boolean).join("\n\n");
}

function resolveFlowForMessage(
  flows: QualificationFlowSummary[],
  messageBody: string
) {
  if (!flows.length) return null;

  const lower = String(messageBody || "").trim().toLowerCase();
  const keywordMatched = flows.find((flow) =>
    flow.triggerKeywords.some((keyword) => lower.includes(keyword))
  );
  if (keywordMatched) return keywordMatched;

  return flows.find((flow) => !flow.triggerKeywords.length) || flows[0];
}

function parseLocalizedNumber(value: string) {
  const cleaned = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[R$]/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferBudgetScore(value: number) {
  if (value >= 10000) return 35;
  if (value >= 5000) return 28;
  if (value >= 2000) return 18;
  if (value > 0) return 8;
  return 0;
}

function inferUrgencyScore(value: string) {
  const normalized = normalizeStageKey(value);
  if (
    normalized.includes("agora") ||
    normalized.includes("hoje") ||
    normalized.includes("urgente") ||
    normalized.includes("imediat")
  ) {
    return 30;
  }
  if (
    normalized.includes("semana") ||
    normalized.includes("rapido") ||
    normalized.includes("mes") ||
    normalized.includes("dias")
  ) {
    return 18;
  }
  if (normalized) return 8;
  return 0;
}

function inferAnswerScore(step: QualificationFlowStep, normalizedValue: string | number) {
  let score = Math.max(0, step.baseScore);

  if (step.type === "options") {
    const normalizedAnswer = normalizeStageKey(normalizedValue);
    const matchedOption = step.options.find(
      (option) =>
        normalizeStageKey(option.value) === normalizedAnswer ||
        normalizeStageKey(option.label) === normalizedAnswer
    );
    score += matchedOption?.score || 0;
  }

  if (step.field === "budget" && typeof normalizedValue === "number") {
    score += inferBudgetScore(normalizedValue);
  }

  if (step.field === "urgency") {
    score += inferUrgencyScore(String(normalizedValue || ""));
  }

  if (step.field === "interest" && String(normalizedValue || "").trim()) {
    score += 10;
  }

  if (step.field === "name" && String(normalizedValue || "").trim()) {
    score += 4;
  }

  if (step.field === "citystate" && String(normalizedValue || "").trim()) {
    score += 4;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeAnswerForStep(
  step: QualificationFlowStep,
  messageBody: string
): {
  ok: boolean;
  rawAnswer: string;
  normalizedValue?: string | number;
  score?: number;
  invalidReason?: string;
} {
  const rawAnswer = clipText(messageBody, 1000);
  if (!rawAnswer) {
    return {
      ok: false,
      rawAnswer,
      invalidReason: "Preciso da sua resposta para seguir com a qualificacao.",
    };
  }

  if (step.type === "number") {
    const parsedNumber = parseLocalizedNumber(rawAnswer);
    if (parsedNumber == null) {
      return {
        ok: false,
        rawAnswer,
        invalidReason: "Nao entendi esse valor. Responda usando apenas numeros.",
      };
    }

    return {
      ok: true,
      rawAnswer,
      normalizedValue: parsedNumber,
      score: inferAnswerScore(step, parsedNumber),
    };
  }

  if (step.type === "options") {
    const normalized = normalizeStageKey(rawAnswer);
    const matchedByIndex = step.options[toSafeInt(rawAnswer, 0) - 1] || null;
    const matchedOption =
      matchedByIndex ||
      step.options.find(
        (option) =>
          normalizeStageKey(option.label) === normalized ||
          normalizeStageKey(option.value) === normalized
      ) ||
      null;

    if (!matchedOption) {
      return {
        ok: false,
        rawAnswer,
        invalidReason:
          "Nao identifiquei essa opcao. Responda com o numero ou texto de uma das opcoes.",
      };
    }

    return {
      ok: true,
      rawAnswer,
      normalizedValue: matchedOption.value,
      score: inferAnswerScore(step, matchedOption.value),
    };
  }

  return {
    ok: true,
    rawAnswer,
    normalizedValue: rawAnswer,
    score: inferAnswerScore(step, rawAnswer),
  };
}

async function appendQualificationSummaryToCrm(params: {
  db: DBClient;
  crmId: number;
  summaryText: string;
}) {
  const current = await params.db.get<{ notes: string | null }>(
    `SELECT notes FROM crm WHERE id = ? LIMIT 1`,
    [params.crmId]
  );

  const notes = safeJsonParse<{ text: string; created_at: number }[]>(
    current?.notes,
    []
  );
  notes.unshift({
    text: params.summaryText,
    created_at: Date.now(),
  });

  await params.db.run(`UPDATE crm SET notes = ? WHERE id = ?`, [
    JSON.stringify(notes),
    params.crmId,
  ]);
}

async function applyImmediateCrmAnswerUpdate(params: {
  db: DBClient;
  crmId: number | null | undefined;
  field: QualificationSaveField;
  normalizedValue: string | number;
}) {
  const crmId = toSafeInt(params.crmId, 0);
  if (!crmId) return;

  if (params.field === "name") {
    await params.db.run(`UPDATE crm SET name = ? WHERE id = ?`, [
      clipText(params.normalizedValue, 255) || "Lead",
      crmId,
    ]);
    return;
  }

  if (params.field === "citystate") {
    await params.db.run(`UPDATE crm SET citystate = ? WHERE id = ?`, [
      clipText(params.normalizedValue, 255),
      crmId,
    ]);
    return;
  }

  if (params.field === "budget") {
    await params.db.run(`UPDATE crm SET deal_value = ? WHERE id = ?`, [
      toSafeNumber(params.normalizedValue, 0),
      crmId,
    ]);
    return;
  }

  if (params.field === "notes") {
    const current = await params.db.get<{ notes: string | null }>(
      `SELECT notes FROM crm WHERE id = ? LIMIT 1`,
      [crmId]
    );
    const notes = safeJsonParse<{ text: string; created_at: number }[]>(
      current?.notes,
      []
    );
    notes.unshift({
      text: clipText(params.normalizedValue, 1000),
      created_at: Date.now(),
    });

    await params.db.run(`UPDATE crm SET notes = ? WHERE id = ?`, [
      JSON.stringify(notes),
      crmId,
    ]);
  }
}

function buildQualificationSummary(flow: QualificationFlowSummary, answers: QualificationAnswerRecord[], score: number, stage: QualificationCrmStage) {
  const lines = [
    `Qualificacao automatica: ${flow.name}`,
    ...answers.map(
      (answer) => `- ${answer.question}: ${answer.rawAnswer}`
    ),
    `Score estimado: ${score}`,
    `Estagio sugerido: ${formatStageLabel(stage)}`,
  ];

  return lines.join("\n");
}

function resolveStageFromScore(
  settings: QualificationFlowSettings,
  score: number
): QualificationCrmStage {
  if (score >= settings.hotThreshold) return settings.hotStage;
  if (score >= settings.warmThreshold) return settings.warmStage;
  return settings.coldStage;
}

async function loadActiveFlowsForUser(userId: number) {
  const db = getDB();
  const rows = await db.all<QualificationFlowRow>(
    `
    SELECT *
    FROM qualification_flows
    WHERE user_id = ?
      AND active = 1
    ORDER BY updated_at DESC, id DESC
    `,
    [userId]
  );

  return rows.map((row) => hydrateFlowSummary(row, null));
}

async function loadLatestSessionForChat(userId: number, chatId: string) {
  const db = getDB();
  const row = await db.get<QualificationSessionRow>(
    `
    SELECT *
    FROM qualification_sessions
    WHERE user_id = ?
      AND chat_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
    `,
    [userId, chatId]
  );

  return row || null;
}

async function loadActiveSessionForChat(userId: number, chatId: string) {
  const db = getDB();
  const row = await db.get<QualificationSessionRow>(
    `
    SELECT *
    FROM qualification_sessions
    WHERE user_id = ?
      AND chat_id = ?
      AND status = 'active'
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
    `,
    [userId, chatId]
  );

  return row || null;
}

async function loadFlowById(userId: number, flowId: number) {
  const db = getDB();
  const row = await db.get<QualificationFlowRow>(
    `
    SELECT *
    FROM qualification_flows
    WHERE id = ?
      AND user_id = ?
    LIMIT 1
    `,
    [flowId, userId]
  );

  return row ? hydrateFlowSummary(row, null) : null;
}

export async function getQualificationTextOnlyReminder(params: {
  userId: number;
  chatId: string;
}) {
  const activeSession = await loadActiveSessionForChat(params.userId, params.chatId);
  if (!activeSession?.id) return null;

  const flow = await loadFlowById(params.userId, toSafeInt(activeSession.flow_id));
  if (!flow) return "Me responda em texto para eu continuar sua qualificacao.";

  const currentStep = flow.steps[toSafeInt(activeSession.current_step, 0)];
  if (!currentStep) {
    return "Me responda em texto para eu continuar sua qualificacao.";
  }

  return [
    "Estou no seu questionario de qualificacao.",
    "Para seguir, preciso que voce responda em texto.",
    buildQuestionPrompt(flow, currentStep, toSafeInt(activeSession.current_step, 0), {
      includeIntro: false,
    }),
  ].join("\n\n");
}

export async function processQualificationInboundMessage(
  input: QualificationRuntimeInput
): Promise<QualificationRuntimeResult> {
  const userId = toSafeInt(input.userId, 0);
  const chatId = String(input.chatId || "").trim();
  const messageBody = clipText(input.messageBody, 1000);
  const contactPhone = normalizePhone(input.contactPhone);

  if (!userId || !chatId || !messageBody || !contactPhone) {
    return { handled: false };
  }

  const activeSession = await loadActiveSessionForChat(userId, chatId);
  if (activeSession?.id) {
    const flow = await loadFlowById(userId, toSafeInt(activeSession.flow_id));
    if (!flow || !flow.active) {
      const db = getDB();
      await db.run(
        `UPDATE qualification_sessions SET status = 'cancelled', updated_at = ? WHERE id = ?`,
        [Date.now(), activeSession.id]
      );
      return { handled: false };
    }

    const stepIndex = Math.max(0, toSafeInt(activeSession.current_step, 0));
    const currentStep = flow.steps[stepIndex];
    if (!currentStep) {
      const db = getDB();
      await db.run(
        `UPDATE qualification_sessions
         SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ?`,
        [Date.now(), Date.now(), activeSession.id]
      );
      return { handled: false };
    }

    const parsedAnswer = normalizeAnswerForStep(currentStep, messageBody);
    if (!parsedAnswer.ok) {
      return {
        handled: true,
        responseText: buildQuestionPrompt(flow, currentStep, stepIndex, {
          invalidReason: parsedAnswer.invalidReason || null,
        }),
        flowId: flow.id,
        sessionId: toSafeInt(activeSession.id),
      };
    }

    const answerRecord: QualificationAnswerRecord = {
      stepId: currentStep.id,
      question: currentStep.question,
      type: currentStep.type,
      field: currentStep.field,
      rawAnswer: parsedAnswer.rawAnswer,
      normalizedValue: parsedAnswer.normalizedValue as string | number,
      score: toSafeInt(parsedAnswer.score, 0),
      answeredAt: Date.now(),
    };

    const answers = [...hydrateAnswers(activeSession.answers), answerRecord];
    const nextStepIndex = stepIndex + 1;
    const now = Date.now();

    const completion = await withDBTransaction(async (db) => {
      await applyImmediateCrmAnswerUpdate({
        db,
        crmId: activeSession.crm_id,
        field: currentStep.field,
        normalizedValue: answerRecord.normalizedValue,
      });

      if (nextStepIndex < flow.steps.length) {
        await db.run(
          `
          UPDATE qualification_sessions
          SET answers = ?,
              current_step = ?,
              contact_name = COALESCE(?, contact_name),
              last_answer_at = ?,
              last_question_at = ?,
              updated_at = ?
          WHERE id = ?
          `,
          [
            JSON.stringify(answers),
            nextStepIndex,
            currentStep.field === "name"
              ? clipText(answerRecord.normalizedValue, 255)
              : input.contactName || activeSession.contact_name || null,
            now,
            now,
            now,
            activeSession.id,
          ]
        );

        return {
          completed: false,
          score: null,
          stage: null as QualificationCrmStage | null,
        };
      }

      const finalScore = Math.min(
        100,
        answers.reduce((sum, answer) => sum + toSafeInt(answer.score, 0), 0)
      );
      const targetStage = resolveStageFromScore(flow.settings, finalScore);
      const summaryText = buildQualificationSummary(
        flow,
        answers,
        finalScore,
        targetStage
      );

      if (activeSession.crm_id) {
        await appendQualificationSummaryToCrm({
          db,
          crmId: toSafeInt(activeSession.crm_id),
          summaryText,
        });

        await db.run(
          `
          UPDATE crm
          SET stage = ?
          WHERE id = ?
          `,
          [formatStageLabel(targetStage), activeSession.crm_id]
        );
      }

      await db.run(
        `
        UPDATE qualification_sessions
        SET answers = ?,
            current_step = ?,
            status = 'completed',
            score = ?,
            contact_name = COALESCE(?, contact_name),
            last_answer_at = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
        `,
        [
          JSON.stringify(answers),
          flow.steps.length,
          finalScore,
          currentStep.field === "name"
            ? clipText(answerRecord.normalizedValue, 255)
            : input.contactName || activeSession.contact_name || null,
          now,
          now,
          now,
          activeSession.id,
        ]
      );

      return {
        completed: true,
        score: finalScore,
        stage: targetStage,
      };
    });

    if (completion.completed && activeSession.crm_id && completion.stage) {
      const db = getDB();
      const user = await db.get<{ plan: string | null }>(
        `SELECT plan FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );

      await syncDripEnrollmentsForCrmStage({
        userId,
        userPlan: user?.plan,
        crmId: toSafeInt(activeSession.crm_id),
        contactName:
          currentStep.field === "name"
            ? clipText(answerRecord.normalizedValue, 255)
            : input.contactName || activeSession.contact_name || null,
        contactPhone,
        stage: formatStageLabel(completion.stage),
      });
    }

    if (completion.completed) {
      return {
        handled: true,
        responseText: flow.settings.completionMessage,
        completed: true,
        flowId: flow.id,
        sessionId: toSafeInt(activeSession.id),
        score: completion.score,
      };
    }

    const nextStep = flow.steps[nextStepIndex];
    return {
      handled: true,
      responseText: buildQuestionPrompt(flow, nextStep, nextStepIndex, {
        includeIntro: false,
      }),
      flowId: flow.id,
      sessionId: toSafeInt(activeSession.id),
    };
  }

  const [latestSession, activeFlows] = await Promise.all([
    loadLatestSessionForChat(userId, chatId),
    loadActiveFlowsForUser(userId),
  ]);

  if (!activeFlows.length) {
    return { handled: false };
  }

  if (
    latestSession?.status === "completed" ||
    latestSession?.status === "cancelled"
  ) {
    return { handled: false };
  }

  const crmStage = coerceCrmStage(input.crmStage || "Novo");
  if (crmStage !== "Novo") {
    return { handled: false };
  }

  const flow = resolveFlowForMessage(activeFlows, messageBody);
  if (!flow || !flow.steps.length) {
    return { handled: false };
  }

  const now = Date.now();
  const created = await withDBTransaction(async (db) => {
    const result = await db.run(
      `
      INSERT INTO qualification_sessions (
        user_id,
        flow_id,
        crm_id,
        session_name,
        chat_id,
        contact_phone,
        contact_name,
        current_step,
        answers,
        status,
        score,
        last_question_at,
        last_answer_at,
        started_at,
        completed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', NULL, ?, NULL, ?, NULL, ?)
      `,
      [
        userId,
        flow.id,
        toSafeInt(input.crmId, 0) || null,
        clipText(input.sessionName, 255) || null,
        chatId,
        contactPhone,
        clipText(input.contactName, 255) || null,
        JSON.stringify([]),
        now,
        now,
        now,
      ]
    );

    return Number((result as any)?.insertId || 0);
  });

  return {
    handled: true,
    started: true,
    flowId: flow.id,
    sessionId: created || null,
    responseText: buildQuestionPrompt(flow, flow.steps[0], 0, {
      includeIntro: true,
    }),
  };
}
