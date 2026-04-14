// src/routes/webhook.ts
import express from "express";
import Stripe from "stripe";
import { getDB } from "../database";
import { logAudit } from "../utils/audit";

const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

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

    if (!endpointSecret) {
      console.error("❌ STRIPE_WEBHOOK_SECRET não configurado");
      return res.status(500).json({ error: "Webhook secret ausente no servidor" });
    }

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

    const resolveUserId = async (metadataUserId?: any, email?: string | null): Promise<number | null> => {
      const numericId = Number(metadataUserId);
      if (Number.isFinite(numericId) && numericId > 0) return numericId;
      if (email) {
        const userByEmail = await db.get<{ id: number }>(`SELECT id FROM users WHERE email = ?`, [email]);
        if (userByEmail?.id) return userByEmail.id;
      }
      return null;
    };

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

        const plan = session.metadata?.plan;
        const email = session.customer_email;
        const subscriptionId = session.subscription as string | null;
        const userId = await resolveUserId(session.metadata?.user_id, email || null);

        if (!userId) {
          console.warn("[stripe] checkout.session.completed sem userId resolvido", {
            eventId: event.id,
            email,
            metadata: session.metadata,
          });
        }

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

          await logAudit("stripe_checkout_completed", userId, "subscription", subscriptionId, {
            plan,
            email,
            amount: (session.amount_total || 0) / 100,
            eventId: event.id,
          });
        } else if (session.mode === "subscription" && !userId) {
          console.error("[stripe] checkout.session.completed sem userId para subscription", {
            eventId: event.id,
            email,
            metadata: session.metadata,
          });
        }
      }

      // =====================================================
      // 💰 PAGAMENTO APROVADO
      // =====================================================
      if (event.type === "invoice.payment_succeeded") {
        const invoice = event.data.object as InvoiceWithExtras;

        if (invoice.subscription && invoice.payment_intent) {
          let sub = await db.get<{
            user_id: number;
            plan: string;
          }>(
            `SELECT user_id, plan
             FROM subscriptions
             WHERE stripe_subscription_id = ?`,
            [invoice.subscription]
          );

          // Se a subscription ainda não existir (evento chegou antes do checkout), tenta resolver user e criar
          if (!sub) {
            const email = invoice.customer_email || (invoice.customer as string | undefined);
            const userId = await resolveUserId(null, email || null);

            if (!userId) {
              console.error("[stripe] invoice.payment_succeeded sem subscription e sem userId", {
                eventId: event.id,
                subscription: invoice.subscription,
                email,
              });
            } else {
              const planName =
                invoice.lines?.data?.[0]?.plan?.nickname ||
                invoice.lines?.data?.[0]?.plan?.id ||
                "pro";

              await db.run(
                `INSERT INTO subscriptions
                 (user_id, stripe_subscription_id, plan, status, created_at)
                 VALUES (?, ?, ?, 'active', ?)
                 ON DUPLICATE KEY UPDATE status = 'active'`,
                [userId, invoice.subscription, planName, Date.now()]
              );

              sub = { user_id: userId, plan: planName };

              await db.run(
                `UPDATE users
                 SET plan = ?, subscription_id = ?, subscription_status = 'active'
                 WHERE id = ?`,
                [planName, invoice.subscription, userId]
              );
            }
          }

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

            await logAudit("stripe_payment_succeeded", sub.user_id, "subscription", invoice.subscription, {
              paymentId: invoice.payment_intent,
              amount: (invoice.amount_paid || 0) / 100,
              plan: sub.plan,
              eventId: event.id,
            });
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

        await logAudit("stripe_subscription_cancelled", null, "subscription", sub.id, {
          customer: sub.customer,
          status: sub.status,
          eventId: event.id,
        });
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
