import { Router, type Request } from "express";

import { authMiddleware } from "../middlewares/authMiddleware";
import {
  buscarCobranca,
  enviarNotificacaoWhatsApp,
} from "../services/cobrancaService";
import {
  createCheckoutPreference,
  disconnectMpCredentials,
  getMpPublicSettings,
  handleMpWebhookNotification,
  refreshChargeMpStatus,
  saveMpCredentials,
  testMpConnection,
} from "../services/mercadopagoService";
import { logAudit } from "../utils/audit";

const router = Router();

function getUserId(req: Request) {
  return Number((req as any).user?.id || 0);
}

function parseId(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (error && typeof error === "object") {
    const input = error as Record<string, unknown>;
    const causeMessages = Array.isArray(input.cause)
      ? input.cause
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const cause = item as Record<string, unknown>;
            const code = String(cause.code || "").trim();
            const description = String(
              cause.description || cause.message || cause.detail || ""
            ).trim();
            return [code, description].filter(Boolean).join(": ");
          })
          .filter(Boolean)
      : [];

    const topLevel = [
      String(input.message || "").trim(),
      String(input.error_description || "").trim(),
      String(input.error || "").trim(),
    ].filter(Boolean);

    const combined = [...topLevel, ...causeMessages].join(" | ").trim();
    if (combined) {
      return combined;
    }
  }

  return fallback;
}

router.get("/api/mp/settings", authMiddleware, async (req, res) => {
  try {
    const settings = await getMpPublicSettings(getUserId(req));
    return res.json({ ok: true, settings });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(
        error,
        "Erro ao carregar configuração do Mercado Pago."
      ),
    });
  }
});

router.post("/api/mp/settings", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    await saveMpCredentials(
      userId,
      req.body?.access_token,
      req.body?.public_key,
      {
        notifyWhatsapp: Boolean(req.body?.notify_whatsapp),
      }
    );

    await logAudit("mercadopago_settings_save", userId, "user", userId, {
      hasPublicKey: Boolean(String(req.body?.public_key || "").trim()),
      notifyWhatsapp: Boolean(req.body?.notify_whatsapp),
      testMode: /^TEST-/i.test(String(req.body?.access_token || "").trim()),
    });

    const settings = await getMpPublicSettings(userId);
    return res.json({ ok: true, settings });
  } catch (error) {
    const message = getErrorMessage(
      error,
      "Erro ao salvar credenciais do Mercado Pago."
    );
    const status =
      message.includes("Informe o Access Token") ||
      message.includes("inválid") ||
      message.includes("não configurada")
        ? 400
        : 500;

    return res.status(status).json({ ok: false, error: message });
  }
});

router.post("/api/mp/settings/test", authMiddleware, async (req, res) => {
  try {
    const result = await testMpConnection(getUserId(req), {
      accessToken: req.body?.access_token,
    });
    const status = result.ok ? 200 : 400;
    return res.status(status).json({ ok: result.ok, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(
        error,
        "Erro ao testar conexão com o Mercado Pago."
      ),
    });
  }
});

router.delete("/api/mp/settings", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    await disconnectMpCredentials(userId);

    await logAudit("mercadopago_settings_disconnect", userId, "user", userId, {
      disconnectedAt: Date.now(),
    });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(
        error,
        "Erro ao desconectar Mercado Pago."
      ),
    });
  }
});

router.post("/api/cobrancas/:id/mp-checkout", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const cobrancaId = parseId(req.params.id);
    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido." });
    }

    const settings = await getMpPublicSettings(userId);
    if (!settings.configured) {
      return res.status(412).json({
        ok: false,
        needs_configuration: true,
        redirect: "/user#mercadopago",
        error:
          "Configure o Mercado Pago na sua conta antes de gerar links de pagamento.",
      });
    }

    const cobranca = await buscarCobranca(userId, cobrancaId);
    if (!cobranca) {
      return res.status(404).json({ ok: false, error: "Cobrança não encontrada." });
    }

    const result = await createCheckoutPreference(userId, cobranca, {
      expireOnDueDate: req.body?.expire_on_due_date !== false,
      force: Boolean(req.body?.force),
    });

    let whatsapp: { ok: boolean; error?: string } | undefined;
    if (Boolean(req.body?.enviar_whatsapp)) {
      whatsapp = await enviarNotificacaoWhatsApp(
        userId,
        result.cobranca,
        "criacao"
      );
    }

    return res.json({
      ok: true,
      preferenceId: result.preferenceId,
      checkoutUrl: result.checkoutUrl,
      cobranca: result.cobranca,
      whatsapp,
    });
  } catch (error) {
    const message = getErrorMessage(
      error,
      "Erro ao gerar checkout do Mercado Pago."
    );
    console.error("Erro ao gerar checkout do Mercado Pago:", error);
    const status =
      message.includes("não configurado") ||
      message.includes("abertas") ||
      message.includes("inválido") ||
      message.includes("BASE_URL") ||
      message.includes("localhost")
        ? 400
        : 500;

    return res.status(status).json({ ok: false, error: message });
  }
});

router.get("/api/cobrancas/:id/mp-status", authMiddleware, async (req, res) => {
  try {
    const userId = getUserId(req);
    const cobrancaId = parseId(req.params.id);
    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido." });
    }

    const settings = await getMpPublicSettings(userId);
    let cobranca = await buscarCobranca(userId, cobrancaId);
    if (!cobranca) {
      return res.status(404).json({ ok: false, error: "Cobrança não encontrada." });
    }

    let syncError: string | undefined;
    if (settings.configured && cobranca.mp_payment_id) {
      try {
        cobranca = await refreshChargeMpStatus(userId, cobrancaId);
      } catch (error) {
        syncError = getErrorMessage(
          error,
          "Não foi possível sincronizar o status online."
        );
        cobranca = (await buscarCobranca(userId, cobrancaId)) || cobranca;
      }
    }

    return res.json({
      ok: true,
      configured: settings.configured,
      cobranca,
      mp: {
        status: cobranca.mp_status || null,
        checkout_url: cobranca.mp_checkout_url || null,
        payment_id: cobranca.mp_payment_id || null,
        preference_id: cobranca.mp_preference_id || null,
        updated_at: cobranca.mp_updated_at || null,
      },
      syncError,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(
        error,
        "Erro ao consultar status do pagamento online."
      ),
    });
  }
});

router.post("/webhook/mercadopago/:userId", async (req, res) => {
  const userId = parseId(req.params.userId);

  try {
    if (userId) {
      await handleMpWebhookNotification({
        userId,
        headers: req.headers,
        query: (req.query || {}) as Record<string, unknown>,
        body: (req.body || {}) as Record<string, unknown>,
      });
    }
  } catch (error) {
    console.error("Webhook Mercado Pago não processado:", error);
  }

  return res.status(200).json({ ok: true });
});

router.get("/mp/success", (req, res) => {
  return res.render("mercadopago-return", {
    state: "success",
    title: "Pagamento recebido",
    description:
      "Seu pagamento foi confirmado pelo Mercado Pago. Se necessário, você já pode voltar para o atendimento.",
  });
});

router.get("/mp/failure", (req, res) => {
  return res.render("mercadopago-return", {
    state: "failure",
    title: "Pagamento não concluído",
    description:
      "O checkout foi encerrado sem aprovação. Você pode revisar os dados e tentar novamente.",
  });
});

router.get("/mp/pending", (req, res) => {
  return res.render("mercadopago-return", {
    state: "pending",
    title: "Pagamento em análise",
    description:
      "O pagamento foi recebido e está em processamento. Assim que o Mercado Pago confirmar, a cobrança será atualizada automaticamente.",
  });
});

export default router;
