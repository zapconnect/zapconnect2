import { Router } from "express";
import { getDB } from "../database";
import * as cobranca from "../services/cobrancaService";
import { io } from "../server";
import { getClient } from "../wppManager";

const router = Router();

const MANUAL_NOTIFICATION_TYPES = new Set([
  "criacao",
  "lembrete_vencimento",
  "atraso",
]);

function getUserId(req: any) {
  return Number(req?.user?.id || 0);
}

function parseId(value: any) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : 0;
}

function getErrorMessage(error: unknown, fallback = "Erro interno") {
  return error instanceof Error ? error.message : fallback;
}

function getErrorStatus(error: unknown) {
  const message = getErrorMessage(error, "");
  const lower = message.toLowerCase();
  if (
    lower.includes("não encontrada") ||
    lower.includes("não encontrado") ||
    lower.includes("cliente não encontrado")
  ) {
    return 404;
  }

  if (
    lower.includes("obrigatório") ||
    lower.includes("inválid") ||
    lower.includes("não pode") ||
    lower.includes("não podem") ||
    lower.includes("somente") ||
    lower.includes("já existe") ||
    lower.includes("maior que zero") ||
    lower.includes("parcelas") ||
    lower.includes("cobranças ativas") ||
    lower.includes("recorrências ativas") ||
    lower.includes("atingiu a data final")
  ) {
    return 400;
  }

  return 500;
}

router.get("/cobrancas", (req, res) => {
  res.render("cobrancas", { user: (req as any).user });
});

router.get("/api/cobrancas/summary", async (req, res) => {
  try {
    const summary = await cobranca.getSummary(getUserId(req));
    return res.json({ ok: true, summary });
  } catch (error) {
    console.error("Erro ao carregar summary de cobranças:", error);
    return res.status(500).json({ ok: false, error: "Erro ao carregar dashboard" });
  }
});

router.get("/api/cobrancas/clientes", async (req, res) => {
  try {
    const clientes = await cobranca.listarClientes(
      getUserId(req),
      String(req.query.search || "").trim()
    );
    return res.json({ ok: true, clientes });
  } catch (error) {
    console.error("Erro ao listar clientes de cobrança:", error);
    return res.status(500).json({ ok: false, error: "Erro ao listar clientes" });
  }
});

router.post("/api/cobrancas/clientes", async (req, res) => {
  try {
    const cliente = await cobranca.criarOuBuscarCliente(getUserId(req), req.body || {});
    io.to(`user:${getUserId(req)}`).emit("cobranca:cliente", {
      type: "upsert",
      cliente,
    });
    return res.json({ ok: true, cliente });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao salvar cliente"),
    });
  }
});

router.put("/api/cobrancas/clientes/:id", async (req, res) => {
  try {
    const clienteId = parseId(req.params.id);
    if (!clienteId) {
      return res.status(400).json({ ok: false, error: "ID do cliente inválido" });
    }

    await cobranca.editarCliente(getUserId(req), clienteId, req.body || {});
    io.to(`user:${getUserId(req)}`).emit("cobranca:cliente", {
      type: "update",
      id: clienteId,
    });
    return res.json({ ok: true });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao editar cliente"),
    });
  }
});

router.delete("/api/cobrancas/clientes/:id", async (req, res) => {
  try {
    const clienteId = parseId(req.params.id);
    if (!clienteId) {
      return res.status(400).json({ ok: false, error: "ID do cliente inválido" });
    }

    await cobranca.deletarCliente(getUserId(req), clienteId);
    io.to(`user:${getUserId(req)}`).emit("cobranca:cliente", {
      type: "delete",
      id: clienteId,
    });
    return res.json({ ok: true });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao deletar cliente"),
    });
  }
});

router.get("/api/cobrancas/listar", async (req, res) => {
  try {
    const result = await cobranca.listarCobrancas(getUserId(req), {
      status: String(req.query.status || "all") as any,
      search: String(req.query.search || "").trim(),
      from: String(req.query.from || "").trim(),
      to: String(req.query.to || "").trim(),
      cliente_id: parseId(req.query.cliente_id),
      recorrencia_id: parseId(req.query.recorrencia_id),
      page: parseId(req.query.page) || 1,
      pageSize: parseId(req.query.pageSize) || 15,
    });

    return res.json({ ok: true, ...result });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao listar cobranças"),
    });
  }
});

router.post("/api/cobrancas/criar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const payload = {
      ...(req.body || {}),
      user_id: userId,
    };

    const result = await cobranca.criarCobranca(payload);
    let whatsapp: { ok: boolean; error?: string } | undefined;

    if (payload.enviar_whatsapp) {
      whatsapp = await cobranca.enviarNotificacaoWhatsApp(
        userId,
        result.cobranca,
        "criacao"
      );
    }

    io.to(`user:${userId}`).emit("cobranca:nova", result.cobranca);

    return res.json({
      ok: true,
      cobranca: result.cobranca,
      parcelamentos: result.parcelamentos,
      whatsapp,
    });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao criar cobrança"),
    });
  }
});

router.get("/api/cobrancas/recorrencias/listar", async (req, res) => {
  try {
    const recorrencias = await cobranca.listarRecorrencias(getUserId(req));
    return res.json({ ok: true, recorrencias });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao listar recorrências"),
    });
  }
});

router.post("/api/cobrancas/recorrencias/:id/pausar", async (req, res) => {
  try {
    const recorrenciaId = parseId(req.params.id);
    if (!recorrenciaId) {
      return res.status(400).json({ ok: false, error: "ID da recorrência inválido" });
    }

    await cobranca.pausarRecorrencia(getUserId(req), recorrenciaId);
    io.to(`user:${getUserId(req)}`).emit("cobranca:recorrencia", {
      type: "pause",
      id: recorrenciaId,
    });
    return res.json({ ok: true });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao pausar recorrência"),
    });
  }
});

router.post("/api/cobrancas/recorrencias/:id/reativar", async (req, res) => {
  try {
    const recorrenciaId = parseId(req.params.id);
    if (!recorrenciaId) {
      return res.status(400).json({ ok: false, error: "ID da recorrência inválido" });
    }

    await cobranca.reativarRecorrencia(getUserId(req), recorrenciaId);
    io.to(`user:${getUserId(req)}`).emit("cobranca:recorrencia", {
      type: "resume",
      id: recorrenciaId,
    });
    return res.json({ ok: true });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao reativar recorrência"),
    });
  }
});

router.get("/api/cobrancas/sessoes", async (req, res) => {
  try {
    const userId = getUserId(req);
    const db = getDB();
    const rows = await db.all<{ session_name: string }>(
      `
      SELECT session_name
      FROM sessions
      WHERE user_id = ? AND status = 'connected'
      ORDER BY created_at DESC, id DESC
      `,
      [userId]
    );

    const sessoes = rows
      .filter((row) => Boolean(getClient(`USER${userId}_${row.session_name}`)))
      .map((row) => ({ session_name: row.session_name }));

    return res.json({ ok: true, sessoes });
  } catch (error) {
    console.error("Erro ao listar sessões WPP para cobranças:", error);
    return res.status(500).json({ ok: false, error: "Erro ao listar sessões" });
  }
});

router.get("/api/cobrancas/:id", async (req, res) => {
  try {
    const cobrancaId = parseId(req.params.id);
    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido" });
    }

    const item = await cobranca.buscarCobranca(getUserId(req), cobrancaId);
    if (!item) {
      return res.status(404).json({ ok: false, error: "Cobrança não encontrada" });
    }

    return res.json({ ok: true, cobranca: item });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao buscar cobrança"),
    });
  }
});

router.put("/api/cobrancas/:id", async (req, res) => {
  try {
    const cobrancaId = parseId(req.params.id);
    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido" });
    }

    await cobranca.editarCobranca(getUserId(req), cobrancaId, req.body || {});
    const updated = await cobranca.buscarCobranca(getUserId(req), cobrancaId);
    io.to(`user:${getUserId(req)}`).emit("cobranca:atualizada", updated);
    return res.json({ ok: true });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao editar cobrança"),
    });
  }
});

router.post("/api/cobrancas/:id/pagar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const cobrancaId = parseId(req.params.id);
    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido" });
    }

    const item = await cobranca.marcarComoPago(
      userId,
      cobrancaId,
      req.body?.valor_pago,
      req.body?.pago_em
    );

    let whatsapp: { ok: boolean; error?: string } | undefined;
    if (req.body?.enviar_confirmacao !== false) {
      whatsapp = await cobranca.enviarNotificacaoWhatsApp(
        userId,
        item,
        "confirmacao_pagamento"
      );
    }

    io.to(`user:${userId}`).emit("cobranca:paga", item);

    return res.json({ ok: true, cobranca: item, whatsapp });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao confirmar pagamento"),
    });
  }
});

router.post("/api/cobrancas/:id/cancelar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const cobrancaId = parseId(req.params.id);
    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido" });
    }

    const item = await cobranca.buscarCobranca(userId, cobrancaId);
    if (!item) {
      return res.status(404).json({ ok: false, error: "Cobrança não encontrada" });
    }

    await cobranca.cancelarCobranca(userId, cobrancaId);
    const updated = await cobranca.buscarCobranca(userId, cobrancaId);

    let whatsapp: { ok: boolean; error?: string } | undefined;
    if (req.body?.enviar_whatsapp === true && updated?.session_name) {
      whatsapp = await cobranca.enviarNotificacaoWhatsApp(
        userId,
        updated,
        "cancelamento"
      );
    }

    io.to(`user:${userId}`).emit("cobranca:cancelada", updated || { id: cobrancaId });

    return res.json({ ok: true, whatsapp });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao cancelar cobrança"),
    });
  }
});

router.post("/api/cobrancas/:id/notificar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const cobrancaId = parseId(req.params.id);
    const tipo = String(req.body?.tipo || "").trim();

    if (!cobrancaId) {
      return res.status(400).json({ ok: false, error: "ID da cobrança inválido" });
    }

    if (!MANUAL_NOTIFICATION_TYPES.has(tipo)) {
      return res.status(400).json({ ok: false, error: "Tipo de notificação inválido" });
    }

    const item = await cobranca.buscarCobranca(userId, cobrancaId);
    if (!item) {
      return res.status(404).json({ ok: false, error: "Cobrança não encontrada" });
    }

    const result = await cobranca.enviarNotificacaoWhatsApp(
      userId,
      item,
      tipo as "criacao" | "lembrete_vencimento" | "atraso"
    );

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao enviar notificação"),
    });
  }
});

export default router;
