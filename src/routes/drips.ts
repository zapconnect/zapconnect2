import express from "express";
import { getDB } from "../database";
import { subscriptionGuard } from "../middlewares/subscriptionGuard";
import {
  DRIP_TRIGGER_STAGES,
  deleteDripCampaign,
  getDripPlanAccess,
  listDripCampaignsForUser,
  listDripEnrollmentsForCampaign,
  saveDripCampaign,
} from "../services/dripCampaignService";

const router = express.Router();

function serializeAccess(access: ReturnType<typeof getDripPlanAccess>) {
  return {
    plan: access.plan,
    maxMonthlyEnrollments: access.maxMonthlyEnrollments,
    monthlyEnrollmentsUsed: access.monthlyEnrollmentsUsed,
    monthlyEnrollmentsRemaining: access.monthlyEnrollmentsRemaining,
  };
}

async function loadDripBootstrap(userId: number, userPlan: string | null | undefined) {
  const db = getDB();
  const [campaignData, sessions] = await Promise.all([
    listDripCampaignsForUser({
      userId,
      userPlan,
    }),
    db.all<{ session_name: string; status: string }>(
      `
      SELECT session_name, status
      FROM sessions
      WHERE user_id = ?
      ORDER BY (status = 'connected') DESC, id DESC
      `,
      [userId]
    ),
  ]);

  return {
    campaigns: campaignData.campaigns,
    access: serializeAccess(campaignData.access),
    stages: DRIP_TRIGGER_STAGES,
    sessions,
  };
}

router.get("/drips", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const dripBootstrap = await loadDripBootstrap(Number(user.id), user.plan);

    res.render("drips", {
      user,
      dripBootstrap: {
        campaigns: [],
        access: dripBootstrap.access,
        stages: dripBootstrap.stages,
        sessions: dripBootstrap.sessions,
      },
    });
  } catch (err) {
    console.error("Erro ao carregar painel drip:", err);
    return res.status(500).send("Nao foi possivel carregar o painel de automacao.");
  }
});

router.get("/api/drips/campaigns", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const payload = await loadDripBootstrap(Number(user.id), user.plan);

    return res.json({
      ok: true,
      ...payload,
    });
  } catch (err) {
    console.error("Erro ao listar campanhas drip:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível carregar as campanhas drip.",
    });
  }
});

router.get("/api/drips/campaigns/:id/enrollments", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const campaignId = Number(req.params.id || 0);
    const limit = Number(req.query.limit || 15);

    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Campanha inválida.",
      });
    }

    const enrollments = await listDripEnrollmentsForCampaign({
      userId: Number(user.id),
      campaignId,
      limit,
    });

    return res.json({
      ok: true,
      enrollments,
    });
  } catch (err) {
    console.error("Erro ao listar enrollments drip:", err);
    return res.status(500).json({
      ok: false,
      error: "Não foi possível carregar os inscritos da campanha.",
    });
  }
});

router.post("/api/drips/campaigns", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const campaign = await saveDripCampaign({
      userId: Number(user.id),
      input: req.body || {},
    });

    return res.json({
      ok: true,
      campaign,
    });
  } catch (err: any) {
    console.error("Erro ao salvar campanha drip:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Não foi possível salvar a campanha drip.",
    });
  }
});

router.delete("/api/drips/campaigns/:id", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const campaignId = Number(req.params.id || 0);
    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Campanha inválida.",
      });
    }

    await deleteDripCampaign({
      userId: Number(user.id),
      campaignId,
    });

    return res.json({ ok: true });
  } catch (err: any) {
    console.error("Erro ao deletar campanha drip:", err);
    return res.status(400).json({
      ok: false,
      error: err?.message || "Não foi possível remover a campanha drip.",
    });
  }
});

export default router;
