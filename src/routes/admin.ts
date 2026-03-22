import express from "express";
import { getDB } from "../database";

const router = express.Router();
const email = "viniciussowza16@gmail.com";

router.get("/", (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).send("Acesso negado");
  res.render("dashboard");
});

router.get("/dashboard-data", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  const db = getDB();

  // ── Stats gerais ──────────────────────────────────────────
  const totalUsers = (await db.get<{ t: number }>(`SELECT COUNT(*) t FROM users`))?.t ?? 0;
  const active     = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='active'`)).t;
  const cancelled  = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='cancelled'`)).t;
  const pastDue    = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='past_due'`)).t;

  const revenue = (await db.get(`
    SELECT IFNULL(SUM(amount),0) t
    FROM payments WHERE status='approved'
  `)).t;

  const mrr = (await db.get(`
    SELECT IFNULL(SUM(amount),0) t
    FROM payments
    WHERE status='approved'
      AND created_at >= ?
  `, [Date.now() - 30 * 24 * 60 * 60 * 1000])).t;

  const ticket = (await db.get(`
    SELECT IFNULL(AVG(amount),0) t
    FROM payments WHERE status='approved'
  `)).t;

  const leads = (await db.get(`
    SELECT COUNT(*) t
    FROM checkout_leads WHERE event_type='preapproval_created'
  `)).t;

  const abandoned = (await db.get(`
    SELECT COUNT(*) t FROM checkout_leads l
    WHERE l.event_type='preapproval_created'
      AND NOT EXISTS (
        SELECT 1 FROM payments p WHERE p.user_id = l.user_id
      )
  `)).t;

  // ── Receita mensal (últimos 7 meses) para o gráfico de barras ──
  const monthlyRevenue = await db.all(`
    SELECT
      DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m') AS month,
      SUM(amount) AS total
    FROM payments
    WHERE status = 'approved'
      AND created_at >= ?
    GROUP BY month
    ORDER BY month ASC
  `, [Date.now() - 7 * 30 * 24 * 60 * 60 * 1000]);

  // ── Novos usuários por dia (últimos 28 dias) ──
  const dailyNewUsers = await db.all(`
    SELECT
      DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
      COUNT(*) AS count
    FROM users
    WHERE created_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `, [Date.now() - 28 * 24 * 60 * 60 * 1000]);

  // ── Pagamentos por dia (últimos 49 dias — 7 semanas) para o heatmap ──
  const dailyPayments = await db.all(`
    SELECT
      DATE_FORMAT(FROM_UNIXTIME(created_at / 1000), '%Y-%m-%d') AS day,
      COUNT(*) AS count
    FROM payments
    WHERE status = 'approved'
      AND created_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `, [Date.now() - 49 * 24 * 60 * 60 * 1000]);

  // ── Lista de usuários ──
  const users = await db.all(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.plan,
      u.subscription_status,
      u.created_at,

      (SELECT p.amount
       FROM payments p
       WHERE p.user_id = u.id AND p.status = 'approved'
       ORDER BY p.created_at DESC LIMIT 1) AS last_amount,

      (SELECT p.payment_method
       FROM payments p
       WHERE p.user_id = u.id AND p.status = 'approved'
       ORDER BY p.created_at DESC LIMIT 1) AS last_method,

      (SELECT p.created_at
       FROM payments p
       WHERE p.user_id = u.id AND p.status = 'approved'
       ORDER BY p.created_at DESC LIMIT 1) AS last_payment_at,

      (SELECT COUNT(*)
       FROM payments p
       WHERE p.user_id = u.id AND p.status != 'approved') AS failures,

      CASE
        WHEN EXISTS (
          SELECT 1 FROM checkout_leads cl
          WHERE cl.user_id = u.id
            AND cl.event_type = 'preapproval_created'
            AND cl.created_at < (UNIX_TIMESTAMP() * 1000 - 30 * 60 * 1000)
            AND NOT EXISTS (
              SELECT 1 FROM payments p2
              WHERE p2.user_id = u.id AND p2.status = 'approved'
            )
        ) THEN 1 ELSE 0
      END AS abandoned

    FROM users u
    ORDER BY abandoned DESC, u.id DESC
  `);

  res.json({
    stats: {
      totalUsers,
      active,
      cancelled,
      pastDue,
      revenue,
      mrr,
      ticket,
      leads,
      abandoned,
    },
    chartData: {
      monthlyRevenue,  // [{ month: '2025-01', total: 4200 }, ...]
      dailyNewUsers,   // [{ day: '2025-03-01', count: 12 }, ...]
      dailyPayments,   // [{ day: '2025-03-01', count: 8  }, ...]
    },
    users,
  });
});

export default router;