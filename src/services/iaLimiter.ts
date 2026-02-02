// src/services/iaLimiter.ts
import { getDB } from "../database";
import { PLANS, PlanName } from "../config/plans";

const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;

export async function canUseIA(userId: number): Promise<boolean> {
  const db = getDB();

  const user = await db.get<{
    plan: PlanName;
    ia_messages_used: number;
    ia_messages_reset_at: number | null;
    plan_expires_at: number | null;
    subscription_status: "trial" | "active" | "cancelled" | "paused" | "past_due";
  }>(
    `SELECT 
       plan,
       ia_messages_used,
       ia_messages_reset_at,
       plan_expires_at,
       subscription_status
     FROM users
     WHERE id = ?`,
    [userId]
  );

  if (!user) return false;

  // 🔒 Status inválido
  if (!["trial", "active"].includes(user.subscription_status)) {
    return false;
  }

  // ⏱ Trial expirado
  if (
    user.subscription_status === "trial" &&
    user.plan_expires_at &&
    user.plan_expires_at < Date.now()
  ) {
    return false;
  }

  const planConfig = PLANS[user.plan];
  if (!planConfig) return false;

  const now = Date.now();

  // ♻️ Reset mensal somente quando expira
  if (!user.ia_messages_reset_at || user.ia_messages_reset_at <= now) {
    const nextReset = now + ONE_MONTH;

    await db.run(
      `UPDATE users
       SET ia_messages_used = 0,
           ia_messages_reset_at = ?
       WHERE id = ?`,
      [nextReset, userId]
    );

    user.ia_messages_used = 0;
  }

  // ♾️ Plano ilimitado
  if (planConfig.maxIaMessages === "unlimited") {
    return true;
  }

  return user.ia_messages_used < planConfig.maxIaMessages;
}

export async function consumeIaMessage(userId: number): Promise<boolean> {
  const db = getDB();

  // 🔐 Incremento seguro (evita race condition)
  const result = await db.run(
    `
    UPDATE users
    SET ia_messages_used = ia_messages_used + 1
    WHERE id = ?
    `,
    [userId]
  );

  return result.affectedRows === 1;
}