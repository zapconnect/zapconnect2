import { getDB, type DBClient } from "../database";
import {
  classifyDispatchError,
  evaluateDispatchCampaignRisk,
  evaluateDispatchPolicy,
  evaluateDispatchSessionHealth,
  recordDispatchContactEvent,
} from "../services/dispatchPolicy";
import {
  SessionRateLimitError,
  assertSessionCanSend,
  recordSessionSend,
} from "../utils/humanDelay";
import { withTimeout } from "../utils/withTimeout";
import { ensureChat, getClient } from "../wppManager";

const WPP_TIMEOUT_MS = Number(process.env.WPP_TIMEOUT_MS || 12_000);
const DRIP_WORKER_BATCH_SIZE = Math.max(
  1,
  Number(process.env.DRIP_WORKER_BATCH_SIZE || 10)
);
const DRIP_WORKER_IDLE_MS = Math.max(
  1_000,
  Number(process.env.DRIP_WORKER_IDLE_MS || 20_000)
);
const DRIP_WORKER_MIN_DELAY_MS = Math.max(
  250,
  Number(process.env.DRIP_WORKER_MIN_DELAY_MS || 1_000)
);
const DRIP_WORKER_MAX_DELAY_MS = Math.max(
  DRIP_WORKER_MIN_DELAY_MS,
  Number(process.env.DRIP_WORKER_MAX_DELAY_MS || 30_000)
);
const DRIP_PROCESSING_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.DRIP_PROCESSING_TIMEOUT_MS || 10 * 60 * 1000)
);
const DRIP_RETRY_DELAY_MS = Math.max(
  60_000,
  Number(process.env.DRIP_RETRY_DELAY_MS || 60 * 60 * 1000)
);
const DRIP_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.DRIP_MAX_ATTEMPTS || 5)
);
const DRIP_WATCHDOG_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.DRIP_WATCHDOG_INTERVAL_MS || 5 * 60 * 1000)
);

type ConnectedSessionRow = {
  user_id: number;
  session_name: string;
};

type WorkerState = {
  running: boolean;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  lastWatchdogAt: number;
};

type DripCampaignRow = {
  id: number;
  user_id: number;
  name: string;
  trigger_stage: string;
  preferred_session: string | null;
  active: number | boolean | null;
};

type DripStepRow = {
  id: number;
  campaign_id: number;
  step_order: number;
  delay_ms: number | string;
  message: string | null;
  file: string | null;
  filename: string | null;
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
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  attempt_count: number | string;
  last_attempt_at: number | string | null;
  processing_started_at: number | string | null;
  last_session_name: string | null;
  last_error: string | null;
};

type DispatchContact = {
  number: string;
  message?: string;
  vars?: Record<string, string>;
};

let sharedWorkerState: WorkerState | null = null;

function toSafeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(0, 30);
}

function uniqueWarnings(warnings: string[] = []) {
  return Array.from(new Set(warnings.filter(Boolean)));
}

function isRetryableDispatchPolicyBlock(reason: string, skipCodes: string[] = []) {
  const normalized = String(reason || "").toLowerCase();
  return (
    normalized.includes("envios s") ||
    normalized.includes("limite diario seguro") ||
    normalized.includes("limite seguro atual") ||
    normalized.includes("aquecimento") ||
    normalized.includes("fase de aquecimento") ||
    skipCodes.includes("cooldown")
  );
}

function renderTemplate(template: string, contact?: DispatchContact): string {
  if (!template) return "";

  const now = new Date();
  const date = now.toLocaleDateString("pt-BR");
  const time = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const vars: Record<string, string> = {
    numero: contact?.number || "",
    number: contact?.number || "",
    data: date,
    hoje: date,
    hora: time,
    horario: time,
    ...(contact?.vars || {}),
  };

  return template.replace(/{{\s*([\w.-]+)\s*}}/gi, (_match, rawKey) => {
    const key = String(rawKey || "").toLowerCase();
    return vars[key] !== undefined ? String(vars[key]) : "";
  });
}

async function recordSkippedDispatchContacts(
  db: DBClient,
  input: {
    userId: number;
    campaignRef: string;
    skips: { number: string; code: string; reason: string }[];
  }
) {
  for (const skip of input.skips) {
    await recordDispatchContactEvent(
      {
        userId: input.userId,
        campaignKind: "drip",
        campaignRef: input.campaignRef,
        phone: skip.number,
        status: "skipped",
        errorCode: skip.code,
        errorMessage: skip.reason,
      },
      db
    );
  }
}

async function loadConnectedSessionsByUser(
  db: DBClient,
  userIds: number[]
): Promise<Map<number, string[]>> {
  const uniqueUserIds = Array.from(
    new Set(userIds.map((id) => toSafeInt(id)).filter(Boolean))
  );
  const grouped = new Map<number, string[]>();

  if (!uniqueUserIds.length) return grouped;

  const placeholders = uniqueUserIds.map(() => "?").join(", ");
  const rows = await db.all<ConnectedSessionRow>(
    `
    SELECT user_id, session_name
    FROM sessions
    WHERE status = 'connected'
      AND user_id IN (${placeholders})
    ORDER BY user_id ASC, created_at DESC, id DESC
    `,
    uniqueUserIds
  );

  for (const row of rows) {
    const current = grouped.get(row.user_id) || [];
    current.push(row.session_name);
    grouped.set(row.user_id, current);
  }

  return grouped;
}

function buildSessionCandidates(
  preferredSession: string | null | undefined,
  connectedSessions: string[]
) {
  const preferred = String(preferredSession || "").trim();
  if (preferred && connectedSessions.includes(preferred)) {
    return [
      preferred,
      ...connectedSessions.filter((sessionName) => sessionName !== preferred),
    ];
  }
  return [...connectedSessions];
}

async function claimDueDripEnrollments(
  limit: number
): Promise<DripEnrollmentRow[]> {
  const db = getDB();
  const safeLimit = Math.max(1, Math.trunc(limit || 1));
  const now = Date.now();
  const due = await db.all<{ id: number }>(
    `
    SELECT de.id
    FROM drip_enrollments de
    INNER JOIN drip_campaigns dc
      ON dc.id = de.campaign_id
    WHERE de.status = 'pending'
      AND de.next_send_at IS NOT NULL
      AND de.next_send_at <= ?
      AND dc.active = 1
    ORDER BY de.next_send_at ASC, de.id ASC
    LIMIT ?
    `,
    [now, safeLimit]
  );

  if (!due.length) return [];

  const ids = due
    .map((row) => toSafeInt(row.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];

  const claimedAt = Date.now();
  const placeholders = ids.map(() => "?").join(", ");
  await db.run(
    `
    UPDATE drip_enrollments
    SET status = 'processing',
        processing_started_at = ?,
        last_attempt_at = ?,
        updated_at = ?
    WHERE status = 'pending'
      AND id IN (${placeholders})
    `,
    [claimedAt, claimedAt, claimedAt, ...ids]
  );

  return db.all<DripEnrollmentRow>(
    `
    SELECT *
    FROM drip_enrollments
    WHERE status = 'processing'
      AND processing_started_at = ?
      AND id IN (${placeholders})
    ORDER BY next_send_at ASC, id ASC
    `,
    [claimedAt, ...ids]
  );
}

async function releaseStuckDripEnrollments() {
  const db = getDB();
  const threshold = Date.now() - DRIP_PROCESSING_TIMEOUT_MS;
  await db.run(
    `
    UPDATE drip_enrollments
    SET status = 'pending',
        processing_started_at = NULL,
        updated_at = ?
    WHERE status = 'processing'
      AND processing_started_at IS NOT NULL
      AND processing_started_at < ?
    `,
    [Date.now(), threshold]
  );
}

async function resolveNextDripCycleDelay() {
  const db = getDB();
  const next = await db.get<{ next_send_at: number | string | null }>(
    `
    SELECT de.next_send_at
    FROM drip_enrollments de
    INNER JOIN drip_campaigns dc
      ON dc.id = de.campaign_id
    WHERE de.status = 'pending'
      AND de.next_send_at IS NOT NULL
      AND dc.active = 1
    ORDER BY de.next_send_at ASC, de.id ASC
    LIMIT 1
    `
  );

  const nextTs = toSafeInt(next?.next_send_at, 0);
  if (!nextTs) return DRIP_WORKER_IDLE_MS;

  const diff = nextTs - Date.now();
  return Math.min(
    DRIP_WORKER_MAX_DELAY_MS,
    Math.max(DRIP_WORKER_MIN_DELAY_MS, diff)
  );
}

async function loadCampaignsById(
  db: DBClient,
  campaignIds: number[]
): Promise<Map<number, DripCampaignRow>> {
  const uniqueIds = Array.from(new Set(campaignIds.filter(Boolean)));
  const map = new Map<number, DripCampaignRow>();
  if (!uniqueIds.length) return map;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await db.all<DripCampaignRow>(
    `
    SELECT *
    FROM drip_campaigns
    WHERE id IN (${placeholders})
    `,
    uniqueIds
  );

  for (const row of rows) {
    map.set(toSafeInt(row.id), row);
  }
  return map;
}

async function loadStepsByCampaignId(
  db: DBClient,
  campaignIds: number[]
): Promise<Map<number, DripStepRow[]>> {
  const uniqueIds = Array.from(new Set(campaignIds.filter(Boolean)));
  const map = new Map<number, DripStepRow[]>();
  if (!uniqueIds.length) return map;

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = await db.all<DripStepRow>(
    `
    SELECT *
    FROM drip_steps
    WHERE campaign_id IN (${placeholders})
    ORDER BY campaign_id ASC, step_order ASC, id ASC
    `,
    uniqueIds
  );

  for (const row of rows) {
    const key = toSafeInt(row.campaign_id);
    const current = map.get(key) || [];
    current.push(row);
    map.set(key, current);
  }
  return map;
}

async function completeEnrollment(
  db: DBClient,
  row: DripEnrollmentRow,
  sessionName?: string | null
) {
  const now = Date.now();
  await db.run(
    `
    UPDATE drip_enrollments
    SET status = 'completed',
        next_send_at = NULL,
        processing_started_at = NULL,
        completed_at = ?,
        last_session_name = COALESCE(?, last_session_name),
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
    `,
    [now, sessionName || null, now, row.id]
  );
}

async function failEnrollment(
  db: DBClient,
  row: DripEnrollmentRow,
  errorMessage: string
) {
  const now = Date.now();
  await db.run(
    `
    UPDATE drip_enrollments
    SET status = 'failed',
        processing_started_at = NULL,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
    `,
    [String(errorMessage || "Falha ao enviar etapa drip."), now, row.id]
  );
}

async function requeueEnrollment(
  db: DBClient,
  row: DripEnrollmentRow,
  delayMs: number,
  reason: string
) {
  const now = Date.now();
  const nextSendAt = now + Math.max(60_000, delayMs);
  const nextAttempts = toSafeInt(row.attempt_count) + 1;
  await db.run(
    `
    UPDATE drip_enrollments
    SET status = 'pending',
        next_send_at = ?,
        attempt_count = ?,
        processing_started_at = NULL,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
    `,
    [nextSendAt, nextAttempts, reason, now, row.id]
  );
}

async function advanceEnrollmentAfterSend(
  db: DBClient,
  row: DripEnrollmentRow,
  steps: DripStepRow[],
  sessionName: string
) {
  const now = Date.now();
  const nextStepIndex = toSafeInt(row.current_step) + 1;
  const nextStep = steps[nextStepIndex];

  if (!nextStep) {
    await completeEnrollment(db, row, sessionName);
    return;
  }

  await db.run(
    `
    UPDATE drip_enrollments
    SET status = 'pending',
        current_step = ?,
        next_send_at = ?,
        attempt_count = 0,
        processing_started_at = NULL,
        last_session_name = ?,
        last_error = NULL,
        updated_at = ?
    WHERE id = ?
    `,
    [
      nextStepIndex,
      now + Math.max(0, toSafeInt(nextStep.delay_ms)),
      sessionName,
      now,
      row.id,
    ]
  );
}

async function processSingleDripEnrollment(
  db: DBClient,
  row: DripEnrollmentRow,
  campaignsById: Map<number, DripCampaignRow>,
  stepsByCampaignId: Map<number, DripStepRow[]>,
  connectedSessionsByUser: Map<number, string[]>
) {
  const campaign = campaignsById.get(toSafeInt(row.campaign_id));
  const steps = stepsByCampaignId.get(toSafeInt(row.campaign_id)) || [];
  const stepIndex = toSafeInt(row.current_step, 0);
  const step = steps[stepIndex];
  const userId = toSafeInt(row.user_id);
  const attempts = toSafeInt(row.attempt_count);
  const campaignRef = `drip:${row.campaign_id}:${row.id}:${stepIndex}`;

  if (!campaign || !steps.length) {
    await completeEnrollment(db, row, null);
    return;
  }

  if (!step) {
    await completeEnrollment(db, row, row.last_session_name || null);
    return;
  }

  if (attempts >= DRIP_MAX_ATTEMPTS) {
    await failEnrollment(
      db,
      row,
      `A campanha atingiu o limite de ${DRIP_MAX_ATTEMPTS} tentativas nesta etapa.`
    );
    return;
  }

  const connectedSessions = connectedSessionsByUser.get(userId) || [];
  if (!connectedSessions.length) {
    await requeueEnrollment(
      db,
      row,
      DRIP_RETRY_DELAY_MS,
      "Nenhuma sessão conectada disponível para continuar a campanha drip."
    );
    return;
  }

  const sessionCandidates = buildSessionCandidates(
    campaign.preferred_session,
    connectedSessions
  );

  const contact: DispatchContact = {
    number: normalizePhone(row.contact_phone),
    message: step.message || "",
    vars: {
      nome: String(row.contact_name || ""),
      name: String(row.contact_name || ""),
      campanha: String(campaign.name || ""),
      campaign: String(campaign.name || ""),
      etapa: String(stepIndex + 1),
      step: String(stepIndex + 1),
      stage: String(campaign.trigger_stage || ""),
    },
  };

  if (!contact.number) {
    await failEnrollment(db, row, "Contato inválido para a campanha drip.");
    return;
  }

  const policyResult = await evaluateDispatchPolicy({
    db,
    userId,
    contacts: [contact],
    campaignKind: "drip",
    preferredSession: campaign.preferred_session || null,
    scheduledAt: toSafeInt(row.next_send_at, Date.now()),
    plannedCount: 1,
  });

  await recordSkippedDispatchContacts(db, {
    userId,
    campaignRef,
    skips: policyResult.skippedContacts,
  });

  const skipCodes = policyResult.skippedContacts.map((skip) => skip.code);
  if (policyResult.blocked || !policyResult.allowedContacts.length) {
    const reason =
      policyResult.blockReason ||
      "Nenhum contato elegível restou para a campanha drip.";
    if (isRetryableDispatchPolicyBlock(reason, skipCodes)) {
      await requeueEnrollment(db, row, DRIP_RETRY_DELAY_MS, reason);
      return;
    }

    await failEnrollment(db, row, reason);
    return;
  }

  const finalMessage = renderTemplate(
    policyResult.allowedContacts[0]?.message || step.message || "",
    policyResult.allowedContacts[0]
  );

  let retryableReason = "";
  let hardError = "";

  for (const shortName of sessionCandidates) {
    const sessionThrottleKey = `USER${userId}_${shortName}`;
    const client = getClient(sessionThrottleKey);
    if (!client) {
      retryableReason =
        retryableReason || `Sessão ${shortName} indisponível no momento.`;
      continue;
    }

    const sessionHealth = await evaluateDispatchSessionHealth({
      db,
      userId,
      sessionName: shortName,
    });
    if (sessionHealth.blocked) {
      retryableReason = sessionHealth.reason || retryableReason;
      continue;
    }

    const campaignRisk = await evaluateDispatchCampaignRisk({
      db,
      userId,
      sessionName: shortName,
      plannedCount: 1,
      scheduledAt: toSafeInt(row.next_send_at, Date.now()),
    });
    if (campaignRisk.blocked) {
      retryableReason = campaignRisk.reason || retryableReason;
      continue;
    }

    try {
      assertSessionCanSend(sessionThrottleKey);

      const target = await ensureChat(client, contact.number);
      if (step.file) {
        await withTimeout(
          client.sendFile(
            target,
            step.file,
            step.filename || "arquivo",
            finalMessage || ""
          ),
          WPP_TIMEOUT_MS,
          "drip sendFile"
        );
      } else if (finalMessage) {
        await withTimeout(
          client.sendText(target, finalMessage),
          WPP_TIMEOUT_MS,
          "drip sendText"
        );
      } else {
        throw new Error("Etapa drip sem conteúdo para envio.");
      }

      await recordDispatchContactEvent(
        {
          userId,
          sessionName: shortName,
          campaignKind: "drip",
          campaignRef,
          phone: contact.number,
          status: "sent",
        },
        db
      );

      recordSessionSend(sessionThrottleKey);
      await advanceEnrollmentAfterSend(db, row, steps, shortName);
      return;
    } catch (err: any) {
      if (err instanceof SessionRateLimitError) {
        retryableReason = err.message || retryableReason;
        continue;
      }

      const classified = classifyDispatchError(err);
      hardError = classified.message || String(err?.message || err || "");

      await recordDispatchContactEvent(
        {
          userId,
          sessionName: shortName,
          campaignKind: "drip",
          campaignRef,
          phone: contact.number,
          status: "error",
          errorCode: classified.code,
          errorMessage: classified.message,
        },
        db
      );
    }
  }

  if (retryableReason) {
    await requeueEnrollment(
      db,
      row,
      DRIP_RETRY_DELAY_MS,
      retryableReason || "A etapa drip será tentada novamente."
    );
    return;
  }

  await failEnrollment(
    db,
    row,
    hardError || "Nenhuma sessão conseguiu concluir a etapa da campanha drip."
  );
}

async function processClaimedDripEnrollments(rows: DripEnrollmentRow[]) {
  if (!rows.length) return;

  const db = getDB();
  const campaignIds = rows.map((row) => toSafeInt(row.campaign_id));
  const userIds = rows.map((row) => toSafeInt(row.user_id));
  const [campaignsById, stepsByCampaignId, connectedSessionsByUser] =
    await Promise.all([
      loadCampaignsById(db, campaignIds),
      loadStepsByCampaignId(db, campaignIds),
      loadConnectedSessionsByUser(db, userIds),
    ]);

  for (const row of rows) {
    try {
      await processSingleDripEnrollment(
        db,
        row,
        campaignsById,
        stepsByCampaignId,
        connectedSessionsByUser
      );
    } catch (err) {
      console.error("Erro ao processar enrollment drip:", err);
      try {
        await requeueEnrollment(
          db,
          row,
          DRIP_RETRY_DELAY_MS,
          "Erro inesperado ao processar a campanha drip."
        );
      } catch {
        // ignore secondary failure
      }
    }
  }
}

function attachShutdownHooks(state: WorkerState) {
  const stop = () => {
    state.stopped = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

export function startDripWorker() {
  if (sharedWorkerState) return;

  const state: WorkerState = {
    running: false,
    stopped: false,
    timer: null,
    lastWatchdogAt: 0,
  };

  sharedWorkerState = state;
  attachShutdownHooks(state);

  const scheduleNext = (delayMs: number) => {
    if (state.stopped) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void runCycle();
    }, Math.max(0, delayMs));
    state.timer.unref?.();
  };

  const runCycle = async () => {
    if (state.stopped || state.running) return;
    state.running = true;

    let claimedRows: DripEnrollmentRow[] = [];
    try {
      const now = Date.now();
      if (now - state.lastWatchdogAt >= DRIP_WATCHDOG_INTERVAL_MS) {
        await releaseStuckDripEnrollments();
        state.lastWatchdogAt = now;
      }

      claimedRows = await claimDueDripEnrollments(DRIP_WORKER_BATCH_SIZE);
      await processClaimedDripEnrollments(claimedRows);
    } catch (err) {
      console.error("Erro crítico no worker de drip:", err);
    } finally {
      state.running = false;
      if (state.stopped) return;

      const nextDelay = claimedRows.length
        ? 0
        : await resolveNextDripCycleDelay().catch((err) => {
            console.error("Erro ao calcular próximo ciclo drip:", err);
            return DRIP_WORKER_IDLE_MS;
          });

      scheduleNext(nextDelay);
    }
  };

  console.log(
    `⏱️ Worker de drip ativo (batch=${DRIP_WORKER_BATCH_SIZE}, idle=${DRIP_WORKER_IDLE_MS}ms)`
  );
  scheduleNext(0);
}
