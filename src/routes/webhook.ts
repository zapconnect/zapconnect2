// src/routes/webhook.ts
import express from "express";
import Stripe from "stripe";
import { getDB } from "../database";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

// 🔒 Tipagem estendida
type InvoiceWithExtras = Stripe.Invoice & {
  subscription?: string | null;
  payment_intent?: string | null;
};

router.post(
  "/stripe",
  async (req, res) => {
    const sig = req.headers["stripe-signature"] as string;
    let event: Stripe.Event;

    // =====================================================
    // 🔐 VALIDAR WEBHOOK
    // =====================================================
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        endpointSecret
      );
    } catch (err: any) {
      console.error("❌ Webhook inválido:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const db = getDB();

    // =====================================================
    // 🔁 IDEMPOTÊNCIA
    // =====================================================
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
      // =====================================================
      // 🟢 CHECKOUT FINALIZADO
      // =====================================================
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;

        const userId = Number(session.metadata?.user_id);
        const plan = session.metadata?.plan;
        const email = session.customer_email;
        const subscriptionId = session.subscription as string | null;

        // 🧲 LEAD
        await db.run(
          `INSERT INTO checkout_leads
           (user_id, email, stripe_preapproval_id, plan, amount, status, payment_method, event_type, raw_event, created_at)
           VALUES (?, ?, ?, ?, ?, 'approved', 'card', 'checkout_completed', ?, ?)`,
          [
            userId || null,
            email,
            subscriptionId,
            plan,
            (session.amount_total || 0) / 100,
            JSON.stringify(session),
            Date.now(),
          ]
        );

        // 🔐 ASSINATURA
        if (session.mode === "subscription" && userId && plan && subscriptionId) {
          await db.run(
            `INSERT INTO subscriptions
             (user_id, stripe_subscription_id, plan, status, created_at)
             VALUES (?, ?, ?, 'active', ?)
             ON DUPLICATE KEY UPDATE status = 'active'`,
            [userId, subscriptionId, plan, Date.now()]
          );

          await db.run(
            `UPDATE users
             SET plan = ?, subscription_id = ?, subscription_status = 'active'
             WHERE id = ?`,
            [plan, subscriptionId, userId]
          );
        }
      }

      // =====================================================
      // 💰 PAGAMENTO APROVADO
      // =====================================================
      if (event.type === "invoice.payment_succeeded") {
        const invoice = event.data.object as InvoiceWithExtras;

        if (invoice.subscription && invoice.payment_intent) {
          const sub = await db.get<{
            user_id: number;
            plan: string;
          }>(
            `SELECT user_id, plan
             FROM subscriptions
             WHERE stripe_subscription_id = ?`,
            [invoice.subscription]
          );

          if (sub) {
            await db.run(
              `INSERT INTO payments
               (user_id, payment_id, status, amount, plan_name, payment_method, created_at)
               VALUES (?, ?, 'approved', ?, ?, 'card', ?)`,
              [
                sub.user_id,
                invoice.payment_intent,
                (invoice.amount_paid || 0) / 100,
                sub.plan,
                Date.now(),
              ]
            );

            await db.run(
              `INSERT INTO checkout_leads
               (user_id, stripe_payment_id, plan, amount, status, payment_method, event_type, raw_event, created_at)
               VALUES (?, ?, ?, ?, 'approved', 'card', 'payment_succeeded', ?, ?)`,
              [
                sub.user_id,
                invoice.payment_intent,
                sub.plan,
                (invoice.amount_paid || 0) / 100,
                JSON.stringify(invoice),
                Date.now(),
              ]
            );
          }
        }
      }

      // =====================================================
      // ❌ PAGAMENTO FALHOU
      // =====================================================
      if (event.type === "invoice.payment_failed") {
        const invoice = event.data.object as InvoiceWithExtras;

        await db.run(
          `INSERT INTO checkout_leads
           (stripe_payment_id, status, event_type, raw_event, created_at)
           VALUES (?, 'rejected', 'payment_failed', ?, ?)`,
          [
            invoice.payment_intent,
            JSON.stringify(invoice),
            Date.now(),
          ]
        );
      }

      // =====================================================
      // 🚪 CHECKOUT ABANDONADO
      // =====================================================
      if (event.type === "checkout.session.expired") {
        const session = event.data.object as Stripe.Checkout.Session;

        await db.run(
          `INSERT INTO checkout_leads
           (email, status, event_type, raw_event, created_at)
           VALUES (?, 'cancelled', 'abandoned', ?, ?)`,
          [
            session.customer_email,
            JSON.stringify(session),
            Date.now(),
          ]
        );
      }

      // =====================================================
      // ⛔ ASSINATURA CANCELADA
      // =====================================================
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object as Stripe.Subscription;

        await db.run(
          `INSERT INTO checkout_leads
           (stripe_preapproval_id, status, event_type, raw_event, created_at)
           VALUES (?, 'cancelled', 'subscription_cancelled', ?, ?)`,
          [
            sub.id,
            JSON.stringify(sub),
            Date.now(),
          ]
        );

        await db.run(
          `UPDATE users
           SET plan = 'free',
               subscription_status = 'cancelled',
               subscription_id = NULL
           WHERE subscription_id = ?`,
          [sub.id]
        );
      }

      // =====================================================
      // ✅ MARCAR EVENTO PROCESSADO
      // =====================================================
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
  }
);

export default router;