// src/middlewares/subscriptionGuard.ts
import { Request, Response, NextFunction } from "express";
import { getDB } from "../database";
import { PlanName } from "../config/plans";
import { getPlanConfig } from "../services/planConfigs";

interface AuthUser {
  id: number;
  plan: PlanName;
  subscription_status?: "trial" | "active" | "cancelled" | "paused" | "past_due";
  plan_expires_at?: number | string | null;
}

export async function subscriptionGuard(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user = (req as any).user as AuthUser;

  if (!user) {
    return res.redirect("/login");
  }

  // ===============================
  // 🔐 STATUS DA ASSINATURA
  // ===============================
  if (
    user.subscription_status &&
    !["trial", "active"].includes(user.subscription_status)
  ) {
    return res.redirect("/checkout?status=" + user.subscription_status);
  }

  const plan = user.plan;

  const planConfig = await getPlanConfig(plan);

  if (!plan || !planConfig) {
    return res.redirect("/checkout");
  }

  // ===============================
  // ⏱ EXPIRAÇÃO DO TRIAL
  // ===============================
  if (user.subscription_status === "trial" && user.plan_expires_at) {
    const expiresAt = Number(user.plan_expires_at);

    if (expiresAt < Date.now()) {
      return res.redirect("/checkout?expired=1");
    }
  }

  // ===============================
  // 🚫 BLOQUEAR FREE SEM ASSINATURA
  // ===============================
  if (plan === "free" && user.subscription_status !== "trial") {
    return res.redirect("/checkout");
  }

  // ===============================
  // 📱 LIMITE DE SESSÕES
  // ===============================
  const db = getDB();

  const row = await db.get<{ total: number }>(
    `SELECT COUNT(*) as total FROM sessions WHERE user_id = ?`,
    [user.id]
  );

  const totalSessions = row?.total ?? 0;

  if (totalSessions >= planConfig.maxSessions) {
    // 🔁 API
    if (req.headers.accept?.includes("application/json")) {
      return res.status(403).json({
        error: `Seu plano permite apenas ${planConfig.maxSessions} sessão(ões).`
      });
    }
  }

  next();
}
