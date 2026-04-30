import Stripe from "stripe";
import { PLAN_NAMES, type PlanName } from "../config/plans";
import { getDB } from "../database";
import { stripe } from "../lib/stripe";
import { logAudit } from "../utils/audit";

const SUBSCRIPTION_RECONCILE_INTERVAL_MS = Math.max(
  30 * 60 * 1000,
  Number(process.env.SUBSCRIPTION_RECONCILE_INTERVAL_MS || 2 * 60 * 60 * 1000)
);
const SUBSCRIPTION_RECONCILE_SHARDS = Math.max(
  1,
  Number(process.env.SUBSCRIPTION_RECONCILE_SHARDS || 10)
);
const SUBSCRIPTION_RECONCILE_BATCH_SIZE = Math.max(
  1,
  Number(process.env.SUBSCRIPTION_RECONCILE_BATCH_SIZE || 25)
);
const SUBSCRIPTION_RECONCILE_DELAY_MS = Math.max(
  250,
  Number(process.env.SUBSCRIPTION_RECONCILE_DELAY_MS || 400)
);
const SUBSCRIPTION_RECONCILE_MAX_RETRIES = Math.max(
  1,
  Number(process.env.SUBSCRIPTION_RECONCILE_MAX_RETRIES || 3)
);
const SUBSCRIPTION_RECONCILE_BACKOFF_MS = Math.max(
  1_000,
  Number(process.env.SUBSCRIPTION_RECONCILE_BACKOFF_MS || 2_000)
);

type LocalSubscriptionStatus =
  | "trial"
  | "active"
  | "cancelled"
  | "paused"
  | "past_due";

type ReconcileRow = {
  id: number;
  email: string;
  plan: string | null;
  subscription_id: string;
  subscription_status: LocalSubscriptionStatus;
  plan_expires_at: number | null;
  stored_plan: string | null;
  stored_status: string | null;
};

type WorkerState = {
  running: boolean;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
};

let sharedWorkerState: WorkerState | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function scheduleNextRun(state: WorkerState, delayMs: number) {
  if (state.stopped) return;

  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    void runCycle(state);
  }, delayMs);

  if (typeof state.timer.unref === "function") {
    state.timer.unref();
  }
}

function currentShard() {
  return (
    Math.floor(Date.now() / SUBSCRIPTION_RECONCILE_INTERVAL_MS) %
    SUBSCRIPTION_RECONCILE_SHARDS
  );
}

function normalizePlan(value: unknown): PlanName | null {
  const normalized = String(value || "").trim().toLowerCase();
  return PLAN_NAMES.includes(normalized as PlanName)
    ? (normalized as PlanName)
    : null;
}

function mapStripeStatus(status: Stripe.Subscription.Status): LocalSubscriptionStatus {
  const statusMap: Record<string, LocalSubscriptionStatus> = {
    active: "active",
    past_due: "past_due",
    canceled: "cancelled",
    unpaid: "past_due",
    trialing: "trial",
    paused: "paused",
    incomplete: "past_due",
    incomplete_expired: "cancelled",
  };

  return statusMap[String(status || "").toLowerCase()] || "past_due";
}

function isRetryableStripeError(err: unknown) {
  const anyErr = err as any;
  const code = String(anyErr?.code || "").toLowerCase();
  const type = String(anyErr?.type || "").toLowerCase();
  const message = String(anyErr?.message || "").toLowerCase();
  const statusCode = Number(anyErr?.statusCode || 0);

  return (
    statusCode === 429 ||
    ["ratelimiterror", "apiconnectionerror", "apierror"].includes(type) ||
    ["rate_limit", "lock_timeout", "ecconnreset", "etimedout", "econnreset"].includes(code) ||
    message.includes("rate limit") ||
    message.includes("timed out")
  );
}

function isResourceMissingError(err: unknown) {
  const anyErr = err as any;
  return (
    Number(anyErr?.statusCode || 0) === 404 ||
    String(anyErr?.code || "").toLowerCase() === "resource_missing"
  );
}

async function retrieveStripeSubscription(subscriptionId: string) {
  let attempt = 0;

  while (attempt < SUBSCRIPTION_RECONCILE_MAX_RETRIES) {
    try {
      return await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      attempt += 1;

      if (!isRetryableStripeError(err) || attempt >= SUBSCRIPTION_RECONCILE_MAX_RETRIES) {
        throw err;
      }

      const delay = SUBSCRIPTION_RECONCILE_BACKOFF_MS * attempt;
      await sleep(delay);
    }
  }

  throw new Error("Falha ao consultar assinatura no Stripe");
}

function derivePlan(row: ReconcileRow, subscription: Stripe.Subscription): PlanName | null {
  const candidates: Array<unknown> = [
    subscription.metadata?.plan,
    ...subscription.items.data.map((item) => item.price?.metadata?.plan),
    ...subscription.items.data.map((item) => item.price?.lookup_key),
    row.stored_plan,
    row.plan,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePlan(candidate);
    if (normalized) return normalized;
  }

  return null;
}

async function markMissingSubscription(row: ReconcileRow) {
  const db = getDB();

  await db.run(
    `UPDATE users
     SET subscription_status = 'cancelled',
         subscription_id = NULL
     WHERE id = ?`,
    [row.id]
  );

  await db.run(
    `UPDATE subscriptions
     SET status = 'cancelled'
     WHERE stripe_subscription_id = ?`,
    [row.subscription_id]
  );

  await logAudit("subscription_reconciled_missing", row.id, "subscription", row.subscription_id, {
    from: row.subscription_status,
    to: "cancelled",
    source: "reconciler",
    reason: "resource_missing",
  });
}

async function reconcileUser(row: ReconcileRow) {
  const db = getDB();
  const subscription = await retrieveStripeSubscription(row.subscription_id);
  const nextStatus = mapStripeStatus(subscription.status);
  const nextPlan = derivePlan(row, subscription);
  const nextTrialExpiresAt =
    nextStatus === "trial" && Number(subscription.trial_end || 0) > 0
      ? Number(subscription.trial_end) * 1000
      : row.plan_expires_at;

  const updates: string[] = [];
  const params: any[] = [];
  const meta: Record<string, any> = {
    from: row.subscription_status,
    to: nextStatus,
    source: "reconciler",
  };

  if (nextStatus !== row.subscription_status) {
    updates.push("subscription_status = ?");
    params.push(nextStatus);
  }

  if (nextPlan && nextPlan !== row.plan && (nextStatus === "active" || nextStatus === "trial")) {
    updates.push("plan = ?");
    params.push(nextPlan);
    meta.planFrom = row.plan;
    meta.planTo = nextPlan;
  }

  if (nextStatus === "trial" && nextTrialExpiresAt !== row.plan_expires_at) {
    updates.push("plan_expires_at = ?");
    params.push(nextTrialExpiresAt);
    meta.planExpiresAt = nextTrialExpiresAt;
  }

  if (!updates.length) {
    return false;
  }

  await db.run(
    `UPDATE users
     SET ${updates.join(", ")}
     WHERE id = ?`,
    [...params, row.id]
  );

  await db.run(
    `UPDATE subscriptions
     SET status = ?,
         plan = COALESCE(?, plan)
     WHERE stripe_subscription_id = ?`,
    [nextStatus, nextPlan, row.subscription_id]
  );

  await logAudit("subscription_reconciled", row.id, "subscription", row.subscription_id, meta);
  return true;
}

async function loadShardUsers(shard: number, lastId = 0) {
  const db = getDB();

  return db.all<ReconcileRow>(
    `
    SELECT
      u.id,
      u.email,
      u.plan,
      u.subscription_id,
      u.subscription_status,
      u.plan_expires_at,
      s.plan AS stored_plan,
      s.status AS stored_status
    FROM users u
    LEFT JOIN subscriptions s
      ON s.stripe_subscription_id = u.subscription_id
    WHERE u.subscription_id IS NOT NULL
      AND u.subscription_id <> ''
      AND u.subscription_status IN ('active', 'past_due', 'cancelled', 'paused')
      AND MOD(u.id, ${SUBSCRIPTION_RECONCILE_SHARDS}) = ?
      AND u.id > ?
    ORDER BY u.id ASC
    LIMIT ?
    `,
    [shard, lastId, SUBSCRIPTION_RECONCILE_BATCH_SIZE]
  );
}

export async function reconcileSubscriptions() {
  const shard = currentShard();
  let lastId = 0;
  let processed = 0;
  let updated = 0;

  while (true) {
    const rows = await loadShardUsers(shard, lastId);
    if (!rows.length) break;

    for (const row of rows) {
      if (processed > 0) {
        await sleep(SUBSCRIPTION_RECONCILE_DELAY_MS);
      }

      try {
        const changed = await reconcileUser(row);
        if (changed) updated += 1;
      } catch (err) {
        if (isResourceMissingError(err)) {
          await markMissingSubscription(row);
          updated += 1;
        } else {
          console.warn(
            `Reconciliação falhou para user ${row.id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      processed += 1;
      lastId = row.id;
    }

    if (rows.length < SUBSCRIPTION_RECONCILE_BATCH_SIZE) {
      break;
    }
  }

  if (processed > 0) {
    console.log(
      `🔄 Reconciliação Stripe concluída (shard=${shard}, processados=${processed}, atualizados=${updated})`
    );
  }

  return { shard, processed, updated };
}

async function runCycle(state: WorkerState) {
  if (state.running || state.stopped) return;

  state.running = true;
  try {
    await reconcileSubscriptions();
  } catch (err) {
    console.error("❌ Erro no reconciliador de assinaturas:", err);
  } finally {
    state.running = false;
    scheduleNextRun(state, SUBSCRIPTION_RECONCILE_INTERVAL_MS);
  }
}

export function startSubscriptionReconciler() {
  if (sharedWorkerState) {
    return sharedWorkerState;
  }

  sharedWorkerState = {
    running: false,
    stopped: false,
    timer: null,
  };

  console.log(
    `🔄 Reconciliador de assinaturas ativo (intervalo=${SUBSCRIPTION_RECONCILE_INTERVAL_MS}ms, shards=${SUBSCRIPTION_RECONCILE_SHARDS}, batch=${SUBSCRIPTION_RECONCILE_BATCH_SIZE})`
  );

  void runCycle(sharedWorkerState);
  return sharedWorkerState;
}
