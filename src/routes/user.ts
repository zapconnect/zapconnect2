import { Router } from "express";
import { getDB } from "../database";

const router = Router();

router.get("/user", async (req, res) => {
  const user = (req as any).user;
  const db = getDB();

  // 🔹 últimos 5 pagamentos
  const payments = await db.all(
    `
    SELECT amount, status, payment_method, created_at
    FROM payments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 5
    `,
    [user.id]
  );

  // 🔹 último pagamento aprovado
  const lastPayment = await db.get(
    `
    SELECT created_at
    FROM payments
    WHERE user_id = ? AND status = 'approved'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [user.id]
  );

  res.render("user", {
    user,
    payments,
    lastPaymentAt: lastPayment?.created_at || null,
    now: Date.now()
  });
});

export default router;
