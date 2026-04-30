import Stripe from "stripe";
import { DBClient, getDB, withDBTransaction } from "../database";
import { logAudit } from "../utils/audit";
import { sendEmail } from "../utils/sendEmail";

export type InvoiceWithExtras = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
  payment_intent?: string | Stripe.PaymentIntent | null;
};

export type StripeWebhookFailureRow = {
  id: number;
  event_id: string;
  event_type: string;
  reason: string;
  payload: string;
  resolved: number;
  resolved_at: number | null;
  resolved_by: string | null;
  created_at: number;
};

function getStripeObjectId(
  value: string | { id?: string | null } | null | undefined
): string | null {
  if (!value) return null;
  if (typeof value === "string") return value || null;
  return typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
}

function normalizePlanName(rawValue?: string | null): string {
  const normalized = String(rawValue || "").trim();
  return normalized || "pro";
}

type InvoiceLineWithLegacyPlan = Stripe.InvoiceLineItem & {
  price?: Stripe.Price | null;
  plan?: {
    nickname?: string | null;
    id?: string | null;
  } | null;
};

export function extractPlanNameFromInvoice(invoice: Stripe.Invoice): string {
  const firstLine = invoice.lines?.data?.[0] as InvoiceLineWithLegacyPlan | undefined;
  return normalizePlanName(
    firstLine?.metadata?.plan ||
      firstLine?.price?.nickname ||
      firstLine?.price?.id ||
      firstLine?.plan?.nickname ||
      firstLine?.plan?.id
  );
}

function formatCurrencyBRL(value?: number | null): string {
  return Number(value || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function buildFailureAlertHtml(input: {
  eventId: string;
  eventType: string;
  reason: string;
  email?: string | null;
  amount?: number | null;
}) {
  const emailLine = input.email
    ? `<p><strong>Email:</strong> ${input.email}</p>`
    : "<p><strong>Email:</strong> n/a</p>";
  const amountLine =
    typeof input.amount === "number"
      ? `<p><strong>Valor:</strong> ${formatCurrencyBRL(input.amount)}</p>`
      : "";

  return `
    <h2>Webhook Stripe com falha de vinculação</h2>
    <p><strong>Evento:</strong> ${input.eventType}</p>
    <p><strong>Event ID:</strong> ${input.eventId}</p>
    <p><strong>Motivo:</strong> ${input.reason}</p>
    ${emailLine}
    ${amountLine}
    <p>O evento foi salvo na fila <code>stripe_webhook_failures</code> para resolução manual.</p>
  `;
}

async function upsertSubscriptionAsActive(
  db: DBClient,
  input: {
    userId: number;
    subscriptionId: string;
    plan: string;
  }
) {
  await db.run(
    `INSERT INTO subscriptions
     (user_id, stripe_subscription_id, plan, status, created_at)
     VALUES (?, ?, ?, 'active', ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       plan = VALUES(plan),
       status = 'active'`,
    [input.userId, input.subscriptionId, input.plan, Date.now()]
  );

  await db.run(
    `UPDATE users
     SET plan = ?,
         subscription_id = ?,
         subscription_status = 'active'
     WHERE id = ?`,
    [input.plan, input.subscriptionId, input.userId]
  );
}

async function upsertCheckoutCompletedLead(
  db: DBClient,
  input: {
    userId: number | null;
    email?: string | null;
    subscriptionId?: string | null;
    plan?: string | null;
    amount: number;
    rawEvent: Stripe.Checkout.Session;
  }
) {
  const rawEvent = JSON.stringify(input.rawEvent);

  if (input.subscriptionId) {
    const existingLead = await db.get<{ id: number }>(
      `SELECT id
       FROM checkout_leads
       WHERE stripe_preapproval_id = ?
         AND event_type = 'checkout_completed'
       ORDER BY id DESC
       LIMIT 1`,
      [input.subscriptionId]
    );

    if (existingLead?.id) {
      await db.run(
        `UPDATE checkout_leads
         SET user_id = ?,
             email = ?,
             plan = ?,
             amount = ?,
             status = 'approved',
             payment_method = 'card',
             raw_event = ?
         WHERE id = ?`,
        [
          input.userId,
          input.email || null,
          input.plan || null,
          input.amount,
          rawEvent,
          existingLead.id,
        ]
      );
      return;
    }
  }

  await db.run(
    `INSERT INTO checkout_leads
     (user_id, email, stripe_preapproval_id, plan, amount, status, payment_method, event_type, raw_event, created_at)
     VALUES (?, ?, ?, ?, ?, 'approved', 'card', 'checkout_completed', ?, ?)`,
    [
      input.userId,
      input.email || null,
      input.subscriptionId || null,
      input.plan || null,
      input.amount,
      rawEvent,
      Date.now(),
    ]
  );
}

async function upsertPaymentSucceededRecords(
  db: DBClient,
  input: {
    userId: number;
    paymentIntentId: string;
    amount: number;
    plan: string;
    rawEvent: InvoiceWithExtras;
  }
) {
  const existingPayment = await db.get<{ id: number }>(
    `SELECT id
     FROM payments
     WHERE payment_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [input.paymentIntentId]
  );

  if (!existingPayment?.id) {
    await db.run(
      `INSERT INTO payments
       (user_id, payment_id, status, amount, plan_name, payment_method, created_at)
       VALUES (?, ?, 'approved', ?, ?, 'card', ?)`,
      [
        input.userId,
        input.paymentIntentId,
        input.amount,
        input.plan,
        Date.now(),
      ]
    );
  }

  const existingLead = await db.get<{ id: number }>(
    `SELECT id
     FROM checkout_leads
     WHERE stripe_payment_id = ?
       AND event_type = 'payment_succeeded'
     ORDER BY id DESC
     LIMIT 1`,
    [input.paymentIntentId]
  );

  if (existingLead?.id) {
    await db.run(
      `UPDATE checkout_leads
       SET user_id = ?,
           plan = ?,
           amount = ?,
           status = 'approved',
           payment_method = 'card',
           raw_event = ?
       WHERE id = ?`,
      [
        input.userId,
        input.plan,
        input.amount,
        JSON.stringify(input.rawEvent),
        existingLead.id,
      ]
    );
    return;
  }

  await db.run(
    `INSERT INTO checkout_leads
     (user_id, stripe_payment_id, plan, amount, status, payment_method, event_type, raw_event, created_at)
     VALUES (?, ?, ?, ?, 'approved', 'card', 'payment_succeeded', ?, ?)`,
    [
      input.userId,
      input.paymentIntentId,
      input.plan,
      input.amount,
      JSON.stringify(input.rawEvent),
      Date.now(),
    ]
  );
}

export async function processStripeCheckoutCompleted(
  db: DBClient,
  input: {
    eventId: string;
    userId: number;
    session: Stripe.Checkout.Session;
  }
) {
  const plan = normalizePlanName(input.session.metadata?.plan);
  const email = input.session.customer_email || null;
  const subscriptionId = getStripeObjectId(
    input.session.subscription as string | Stripe.Subscription | null | undefined
  );
  const amount = (input.session.amount_total || 0) / 100;

  await upsertCheckoutCompletedLead(db, {
    userId: input.userId,
    email,
    subscriptionId,
    plan,
    amount,
    rawEvent: input.session,
  });

  if (input.session.mode === "subscription" && subscriptionId) {
    await upsertSubscriptionAsActive(db, {
      userId: input.userId,
      subscriptionId,
      plan,
    });

    await logAudit(
      "stripe_checkout_completed",
      input.userId,
      "subscription",
      subscriptionId,
      {
        plan,
        email,
        amount,
        eventId: input.eventId,
      }
    );
  }
}

export async function processStripeInvoicePaymentSucceeded(
  db: DBClient,
  input: {
    eventId: string;
    userId: number;
    invoice: InvoiceWithExtras;
  }
) {
  const subscriptionId = getStripeObjectId(input.invoice.subscription);
  const paymentIntentId = getStripeObjectId(input.invoice.payment_intent);

  if (!subscriptionId || !paymentIntentId) {
    return;
  }

  const existingSubscription = await db.get<{
    user_id: number;
    plan: string;
  }>(
    `SELECT user_id, plan
     FROM subscriptions
     WHERE stripe_subscription_id = ?`,
    [subscriptionId]
  );

  const effectiveUserId = existingSubscription?.user_id || input.userId;
  const plan = normalizePlanName(
    existingSubscription?.plan || extractPlanNameFromInvoice(input.invoice)
  );
  const amount = (input.invoice.amount_paid || 0) / 100;

  await upsertSubscriptionAsActive(db, {
    userId: effectiveUserId,
    subscriptionId,
    plan,
  });

  await upsertPaymentSucceededRecords(db, {
    userId: effectiveUserId,
    paymentIntentId,
    amount,
    plan,
    rawEvent: input.invoice,
  });

  await logAudit(
    "stripe_payment_succeeded",
    effectiveUserId,
    "subscription",
    subscriptionId,
    {
      paymentId: paymentIntentId,
      amount,
      plan,
      eventId: input.eventId,
    }
  );
}

export async function recordStripeWebhookFailure(input: {
  eventId: string;
  eventType: string;
  reason: string;
  payload: unknown;
  email?: string | null;
  amount?: number | null;
}) {
  const db = getDB();
  const now = Date.now();

  await db.run(
    `INSERT INTO stripe_webhook_failures
     (event_id, event_type, reason, payload, resolved, resolved_at, resolved_by, created_at)
     VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)
     ON DUPLICATE KEY UPDATE
       event_type = VALUES(event_type),
       reason = VALUES(reason),
       payload = VALUES(payload),
       resolved = 0,
       resolved_at = NULL,
       resolved_by = NULL,
       created_at = VALUES(created_at)`,
    [
      input.eventId,
      input.eventType,
      input.reason.slice(0, 255),
      JSON.stringify(input.payload),
      now,
    ]
  );

  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim();
  if (!adminEmail) {
    console.warn("[stripe] ADMIN_EMAIL não configurado para alertas de falha");
    return;
  }

  try {
    await sendEmail(
      adminEmail,
      `⚠️ Falha no webhook Stripe - ${input.eventId}`,
      buildFailureAlertHtml({
        eventId: input.eventId,
        eventType: input.eventType,
        reason: input.reason,
        email: input.email,
        amount: input.amount,
      })
    );
  } catch (err) {
    console.error("[stripe] erro ao enviar alerta de falha do webhook:", err);
  }
}

export async function listStripeWebhookFailures(resolved?: boolean | null) {
  const db = getDB();
  const where = typeof resolved === "boolean" ? "WHERE resolved = ?" : "";
  const params = typeof resolved === "boolean" ? [resolved ? 1 : 0] : [];

  return db.all<StripeWebhookFailureRow>(
    `SELECT id, event_id, event_type, reason, payload, resolved, resolved_at, resolved_by, created_at
     FROM stripe_webhook_failures
     ${where}
     ORDER BY resolved ASC, created_at DESC
     LIMIT 200`,
    params
  );
}

export async function resolveStripeWebhookFailure(input: {
  failureId: number;
  userId: number;
  resolvedBy: string;
}) {
  return withDBTransaction(async (db) => {
    const failure = await db.get<StripeWebhookFailureRow>(
      `SELECT id, event_id, event_type, reason, payload, resolved, resolved_at, resolved_by, created_at
       FROM stripe_webhook_failures
       WHERE id = ?
       FOR UPDATE`,
      [input.failureId]
    );

    if (!failure) {
      throw new Error("FAILURE_NOT_FOUND");
    }

    if (Number(failure.resolved)) {
      throw new Error("FAILURE_ALREADY_RESOLVED");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(failure.payload);
    } catch {
      throw new Error("FAILURE_INVALID_PAYLOAD");
    }

    if (failure.event_type === "checkout.session.completed") {
      await processStripeCheckoutCompleted(db, {
        eventId: failure.event_id,
        userId: input.userId,
        session: payload as Stripe.Checkout.Session,
      });
    } else if (failure.event_type === "invoice.payment_succeeded") {
      await processStripeInvoicePaymentSucceeded(db, {
        eventId: failure.event_id,
        userId: input.userId,
        invoice: payload as InvoiceWithExtras,
      });
    } else {
      throw new Error("FAILURE_UNSUPPORTED_EVENT");
    }

    const processedEvent = await db.get<{ id: number }>(
      `SELECT id FROM stripe_events WHERE event_id = ?`,
      [failure.event_id]
    );

    if (!processedEvent?.id) {
      await db.run(
        `INSERT INTO stripe_events (event_id, type, created_at)
         VALUES (?, ?, ?)`,
        [failure.event_id, failure.event_type, Date.now()]
      );
    }

    await db.run(
      `UPDATE stripe_webhook_failures
       SET resolved = 1,
           resolved_at = ?,
           resolved_by = ?
       WHERE id = ?`,
      [Date.now(), String(input.resolvedBy || "admin").slice(0, 100), input.failureId]
    );

    return failure;
  });
}
