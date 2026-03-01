import express from "express";
import { getDB } from "../database";

const router = express.Router();
const email = "viniciussowza16@gmail.com";

router.get("/", (req, res) => {
  const user = (req as any).user;

  // 🔐 SOMENTE VOCÊ
  if (user.email !== email) {
    return res.status(403).send("Acesso negado");
  }

  res.render("dashboard");
});


router.get("/dashboard-data", async (req, res) => {
  const user = (req as any).user;
  if (user.email !== email) return res.status(403).json({ error: "Acesso negado" });

  const db = getDB();

  const totalUsers = (await db.get(`SELECT COUNT(*) t FROM users`)).t;
  const active = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='active'`)).t;
  const cancelled = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='cancelled'`)).t;
  const pastDue = (await db.get(`SELECT COUNT(*) t FROM users WHERE subscription_status='past_due'`)).t;

  const revenue = (await db.get(`
    SELECT IFNULL(SUM(amount),0) t 
    FROM payments 
    WHERE status='approved'
  `)).t;

  const mrr = (await db.get(`
    SELECT IFNULL(SUM(amount),0) t
    FROM payments
    WHERE status='approved'
      AND created_at >= ?
  `, [Date.now() - 30 * 24 * 60 * 60 * 1000])).t;

  const ticket = (await db.get(`
    SELECT IFNULL(AVG(amount),0) t
    FROM payments
    WHERE status='approved'
  `)).t;

  const leads = (await db.get(`
    SELECT COUNT(*) t 
    FROM checkout_leads
    WHERE event_type='preapproval_created'
  `)).t;

  const abandoned = (await db.get(`
    SELECT COUNT(*) t FROM checkout_leads l
    WHERE l.event_type='preapproval_created'
      AND NOT EXISTS (
        SELECT 1 FROM payments p
        WHERE p.user_id = l.user_id
      )
  `)).t;

  const users = await db.all(`
  SELECT
    u.id,
    u.name,
    u.email,
    u.plan,
    u.subscription_status,

    -- Último pagamento aprovado
    (
      SELECT p.amount
      FROM payments p
      WHERE p.user_id = u.id AND p.status = 'approved'
      ORDER BY p.created_at DESC
      LIMIT 1
    ) AS last_amount,

    (
      SELECT p.payment_method
      FROM payments p
      WHERE p.user_id = u.id AND p.status = 'approved'
      ORDER BY p.created_at DESC
      LIMIT 1
    ) AS last_method,

    (
      SELECT p.created_at
      FROM payments p
      WHERE p.user_id = u.id AND p.status = 'approved'
      ORDER BY p.created_at DESC
      LIMIT 1
    ) AS last_payment_at,

    -- Falhas de pagamento
    (
      SELECT COUNT(*)
      FROM payments p
      WHERE p.user_id = u.id AND p.status != 'approved'
    ) AS failures,

    -- 🚨 LEAD ABANDONADO
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM checkout_leads cl
        WHERE cl.user_id = u.id
          AND cl.event_type = 'preapproval_created'
          AND cl.created_at < (UNIX_TIMESTAMP() * 1000 - 30 * 60 * 1000)
          AND NOT EXISTS (
            SELECT 1
            FROM payments p2
            WHERE p2.user_id = u.id AND p2.status = 'approved'
          )
      )
      THEN 1
      ELSE 0
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
      abandoned
    },
    users
  });
});


export default router;
