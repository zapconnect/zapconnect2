// src/routes/webhook.ts
import express from "express";
import Stripe from "stripe";
import { getDB } from "../database";
import { logAudit } from "../utils/audit";
import {
  InvoiceWithExtras,
  processStripeCheckoutCompleted,
  processStripeInvoicePaymentSucceeded,
  recordStripeWebhookFailure,
} from "../services/stripeWebhookRecovery";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

function getStripeObjectId(
  value: string | { id?: string | null } | null | undefined
): string | null {
  if (!value) return null;
  if (typeof value === "string") return value || null;
  return typeof value.id === "string" && value.id.trim() ? value.id.trim() : null;
}

router.post("/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;

  if (!endpointSecret) {
    console.error("❌ STRIPE_WEBHOOK_SECRET não configurado");
    return res.status(500).json({ error: "Webhook secret ausente no servidor" });
  }

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    console.error("❌ Webhook inválido:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDB();

  const resolveUserId = async (
    metadataUserId?: any,
    email?: string | null
  ): Promise<number | null> => {
    const numericId = Number(metadataUserId);
    if (Number.isFinite(numericId) && numericId > 0) return numericId;

    if (email) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const userByEmail = await db.get<{ id: number }>(
        `SELECT id
         FROM users
         WHERE email = ?
            OR email_normalized = ?
         LIMIT 1`,
        [email, normalizedEmail]
      );
      if (userByEmail?.id) return userByEmail.id;
    }

    return null;
  };

  const processed = await db.get<{ id: number }>(
    `SELECT id FROM stripe_events WHERE event_id = ?`,
    [event.id]
  );

  if (processed) {
    console.log("🔁 Evento duplicado ignorado:", event.id);
    return res.json({ received: true });
  }

  console.log("✅ STRIPE EVENT:", event.type);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const plan = session.metadata?.plan;
      const email = session.customer_email;
      const subscriptionId = getStripeObjectId(
        session.subscription as string | Stripe.Subscription | null | undefined
      );
      const userId = await resolveUserId(session.metadata?.user_id, email || null);

      if (!userId) {
        await db.run(
          `INSERT INTO checkout_leads
           (user_id, email, stripe_preapproval_id, plan, amount, status, payment_method, event_type, raw_event, created_at)
           VALUES (?, ?, ?, ?, ?, 'approved', 'card', 'checkout_completed', ?, ?)`,
          [
            null,
            email || null,
            subscriptionId,
            plan || null,
            (session.amount_total || 0) / 100,
            JSON.stringify(session),
            Date.now(),
          ]
        );

        await recordStripeWebhookFailure({
          eventId: event.id,
          eventType: event.type,
          reason: `user_not_found:email=${email || "n/a"}`,
          payload: session,
          email,
          amount: (session.amount_total || 0) / 100,
        });
      } else {
        await processStripeCheckoutCompleted(db, {
          eventId: event.id,
          userId,
          session,
        });
      }
    }

    if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object as InvoiceWithExtras;
      const subscriptionId = getStripeObjectId(invoice.subscription);
      const paymentIntentId = getStripeObjectId(invoice.payment_intent);

      if (subscriptionId && paymentIntentId) {
        const sub = await db.get<{
          user_id: number;
          plan: string;
        }>(
          `SELECT user_id, plan
           FROM subscriptions
           WHERE stripe_subscription_id = ?`,
          [subscriptionId]
        );

        const fallbackEmail = invoice.customer_email || null;
        const metadataUserId =
          invoice.metadata?.user_id ||
          invoice.lines?.data?.find((line) => line.metadata?.user_id)?.metadata?.user_id;
        const resolvedUserId =
          sub?.user_id || (await resolveUserId(metadataUserId, fallbackEmail));

        if (!resolvedUserId) {
          await recordStripeWebhookFailure({
            eventId: event.id,
            eventType: event.type,
            reason: `user_not_found:email=${fallbackEmail || "n/a"}`,
            payload: invoice,
            email: fallbackEmail,
            amount: (invoice.amount_paid || 0) / 100,
          });
        } else {
          await processStripeInvoicePaymentSucceeded(db, {
            eventId: event.id,
            userId: resolvedUserId,
            invoice,
          });
        }
      }
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as InvoiceWithExtras;

      await db.run(
        `INSERT INTO checkout_leads
         (stripe_payment_id, status, event_type, raw_event, created_at)
         VALUES (?, 'rejected', 'payment_failed', ?, ?)`,
        [getStripeObjectId(invoice.payment_intent), JSON.stringify(invoice), Date.now()]
      );
    }

    if (event.type === "checkout.session.expired") {
      const session = event.data.object as Stripe.Checkout.Session;

      await db.run(
        `INSERT INTO checkout_leads
         (email, status, event_type, raw_event, created_at)
         VALUES (?, 'cancelled', 'abandoned', ?, ?)`,
        [session.customer_email, JSON.stringify(session), Date.now()]
      );
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;

      await db.run(
        `INSERT INTO checkout_leads
         (stripe_preapproval_id, status, event_type, raw_event, created_at)
         VALUES (?, 'cancelled', 'subscription_cancelled', ?, ?)`,
        [sub.id, JSON.stringify(sub), Date.now()]
      );

      await db.run(
        `UPDATE users
         SET plan = 'free',
             subscription_status = 'cancelled',
             subscription_id = NULL
         WHERE subscription_id = ?`,
        [sub.id]
      );

      await logAudit("stripe_subscription_cancelled", null, "subscription", sub.id, {
        customer: sub.customer,
        status: sub.status,
        eventId: event.id,
      });
    }

    await db.run(
      `INSERT INTO stripe_events (event_id, type, created_at)
       VALUES (?, ?, ?)`,
      [event.id, event.type, Date.now()]
    );

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ ERRO WEBHOOK:", err);
    return res.status(500).json({ error: "Webhook error" });
  }
});

export default router;
