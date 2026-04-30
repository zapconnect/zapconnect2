import express from "express";
import { subscriptionGuard } from "../middlewares/subscriptionGuard";
import {
  deleteQualificationFlow,
  getQualificationPlanAccess,
  listQualificationFlowsForUser,
  listQualificationSessionsForFlow,
  QUALIFICATION_CRM_STAGES,
  QUALIFICATION_SAVE_FIELDS,
  QUALIFICATION_STEP_TYPES,
  saveQualificationFlow,
} from "../services/qualificationService";

const router = express.Router();

function serializeAccess(access: ReturnType<typeof getQualificationPlanAccess>) {
  return {
    plan: access.plan,
    maxActiveFlows: access.maxActiveFlows,
    activeFlowsUsed: access.activeFlowsUsed,
    activeFlowsRemaining: access.activeFlowsRemaining,
  };
}

async function loadQualificationBootstrap(
  userId: number,
  userPlan: string | null | undefined
) {
  const flowData = await listQualificationFlowsForUser({
    userId,
    userPlan,
  });

  return {
    flows: flowData.flows,
    access: serializeAccess(flowData.access),
    stepTypes: QUALIFICATION_STEP_TYPES,
    saveFields: QUALIFICATION_SAVE_FIELDS,
    crmStages: QUALIFICATION_CRM_STAGES,
  };
}

router.get("/qualificacao", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const qualificationBootstrap = await loadQualificationBootstrap(
      Number(user.id),
      user.plan
    );

    res.render("qualificacao", {
      user,
      qualificationBootstrap,
    });
  } catch (err) {
    console.error("Erro ao carregar painel de qualificacao:", err);
    return res
      .status(500)
      .send("Nao foi possivel carregar o painel de qualificacao.");
  }
});

router.get("/api/qualification/flows", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const payload = await loadQualificationBootstrap(Number(user.id), user.plan);
    return res.json({
      ok: true,
      ...payload,
    });
  } catch (err) {
    console.error("Erro ao listar fluxos de qualificacao:", err);
    return res.status(500).json({
      ok: false,
      error: "Nao foi possivel carregar os fluxos de qualificacao.",
    });
  }
});

router.get(
  "/api/qualification/flows/:id/sessions",
  subscriptionGuard,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const flowId = Number(req.params.id || 0);
      const limit = Number(req.query.limit || 20);

      if (!Number.isFinite(flowId) || flowId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Fluxo invalido.",
        });
      }

      const sessions = await listQualificationSessionsForFlow({
        userId: Number(user.id),
        flowId,
        limit,
      });

      return res.json({
        ok: true,
        sessions,
      });
    } catch (err) {
      console.error("Erro ao listar sessoes de qualificacao:", err);
      return res.status(500).json({
        ok: false,
        error: "Nao foi possivel carregar as sessoes desse fluxo.",
      });
    }
  }
);

router.post("/api/qualification/flows", subscriptionGuard, async (req, res) => {
  try {
    const user = (req as any).user;
    const flow = await saveQualificationFlow({
      userId: Number(user.id),
      userPlan: user.plan,
      input: req.body || {},
    });

    return res.json({
      ok: true,
      flow,
    });
  } catch (err: any) {
    console.error("Erro ao salvar fluxo de qualificacao:", err);
    return res.status(400).json({
      ok: false,
      error:
        err?.message || "Nao foi possivel salvar o fluxo de qualificacao.",
    });
  }
});

router.delete(
  "/api/qualification/flows/:id",
  subscriptionGuard,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const flowId = Number(req.params.id || 0);

      if (!Number.isFinite(flowId) || flowId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "Fluxo invalido.",
        });
      }

      await deleteQualificationFlow({
        userId: Number(user.id),
        flowId,
      });

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("Erro ao excluir fluxo de qualificacao:", err);
      return res.status(400).json({
        ok: false,
        error:
          err?.message || "Nao foi possivel remover o fluxo de qualificacao.",
      });
    }
  }
);

export default router;
