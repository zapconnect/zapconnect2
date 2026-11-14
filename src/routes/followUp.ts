import express from "express";
import { getDB } from "../database";
import { subscriptionGuard } from "../middlewares/subscriptionGuard";
import {
  approveStalledFollowUp,
  cancelFollowUpItem,
  getFollowUpSettings,
  listFollowUpItems,
  listStalledLeads,
  prepareStalledLeadDraft,
  saveFollowUpSettings,
  updateFollowUpDraft,
} from "../services/followUpService";

const router = express.Router();

function currentUser(req: express.Request) {
  return (req as any).user as { id: number; plan?: string; name?: string };
}

function toPositiveInt(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

router.get("/follow-up", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const [settings, sessions] = await Promise.all([
      getFollowUpSettings(Number(user.id)),
      getDB().all<{ session_name: string; status: string }>(
        `SELECT session_name, status
         FROM sessions WHERE user_id = ?
         ORDER BY (status = 'connected') DESC, created_at DESC, id DESC`,
        [user.id]
      ),
    ]);

    return res.render("followUp", { user, settings, sessions });
  } catch (err) {
    console.error("Erro ao carregar Follow-up:", err);
    return res.status(500).send("Não foi possível carregar o Follow-up.");
  }
});

router.get("/api/follow-up/settings", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const [settings, sessions] = await Promise.all([
      getFollowUpSettings(Number(user.id)),
      getDB().all<{ session_name: string; status: string }>(
        `SELECT session_name, status
         FROM sessions WHERE user_id = ?
         ORDER BY (status = 'connected') DESC, created_at DESC, id DESC`,
        [user.id]
      ),
    ]);
    return res.json({ ok: true, settings, sessions });
  } catch (err) {
    console.error("Erro ao carregar configuração de Follow-up:", err);
    return res.status(500).json({ ok: false, error: "Não foi possível carregar a configuração." });
  }
});

router.put("/api/follow-up/settings", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const settings = await saveFollowUpSettings(Number(user.id), req.body?.settings || req.body);
    return res.json({ ok: true, settings });
  } catch (err: any) {
    return res.status(400).json({
      ok: false,
      error: err?.message || "Não foi possível salvar a configuração.",
    });
  }
});

router.get("/api/follow-up/leads", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const leads = await listStalledLeads({ userId: Number(user.id), limit: 100 });
    return res.json({ ok: true, leads });
  } catch (err) {
    console.error("Erro ao listar leads parados:", err);
    return res.status(500).json({ ok: false, error: "Não foi possível carregar os leads parados." });
  }
});

router.post("/api/follow-up/leads/:crmId/draft", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const crmId = toPositiveInt(req.params.crmId);
    if (!crmId) return res.status(400).json({ ok: false, error: "Contato inválido." });

    const item = await prepareStalledLeadDraft({
      userId: Number(user.id),
      crmId,
      instruction: req.body?.instruction,
    });
    return res.status(201).json({ ok: true, item });
  } catch (err: any) {
    return res.status(400).json({
      ok: false,
      error: err?.message || "Não foi possível preparar a mensagem.",
    });
  }
});

router.get("/api/follow-up/items", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const tab = req.query.tab === "results" ? "results" : "scheduled";
    const items = await listFollowUpItems({ userId: Number(user.id), tab, limit: 100 });
    return res.json({ ok: true, items });
  } catch (err) {
    console.error("Erro ao listar follow-ups:", err);
    return res.status(500).json({ ok: false, error: "Não foi possível carregar os follow-ups." });
  }
});

router.put("/api/follow-up/items/:id/draft", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const itemId = toPositiveInt(req.params.id);
    if (!itemId) return res.status(400).json({ ok: false, error: "Follow-up inválido." });
    await updateFollowUpDraft({
      userId: Number(user.id),
      itemId,
      message: String(req.body?.message || ""),
    });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err?.message || "Não foi possível atualizar a mensagem." });
  }
});

router.post("/api/follow-up/items/:id/approve", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const itemId = toPositiveInt(req.params.id);
    if (!itemId) return res.status(400).json({ ok: false, error: "Follow-up inválido." });
    await approveStalledFollowUp({ userId: Number(user.id), itemId });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err?.message || "Não foi possível aprovar o follow-up." });
  }
});

router.delete("/api/follow-up/items/:id", subscriptionGuard, async (req, res) => {
  try {
    const user = currentUser(req);
    const itemId = toPositiveInt(req.params.id);
    if (!itemId) return res.status(400).json({ ok: false, error: "Follow-up inválido." });
    await cancelFollowUpItem({ userId: Number(user.id), itemId });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ ok: false, error: err?.message || "Não foi possível cancelar o follow-up." });
  }
});

export default router;
