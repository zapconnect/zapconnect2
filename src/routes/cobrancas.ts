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

function parseIdList(values: any) {
  const list = Array.isArray(values) ? values : [];
  return Array.from(
    new Set(
      list.map((value) => parseId(value)).filter((id) => Number.isFinite(id) && id > 0)
    )
  );
}

function getChargeListFilters(req: any) {
  return {
    status: String(req.query.status || "all") as any,
    search: String(req.query.search || "").trim(),
    from: String(req.query.from || "").trim(),
    to: String(req.query.to || "").trim(),
    cliente_id: parseId(req.query.cliente_id) || undefined,
    recorrencia_id: parseId(req.query.recorrencia_id) || undefined,
  };
}

function formatCsvDate(value?: string) {
  if (!value) return "";
  const [year, month, day] = String(value).split("-");
  if (!year || !month || !day) return String(value);
  return `${day}/${month}/${year}`;
}

function formatCsvDateTime(value?: number) {
  if (!value) return "";
  return new Date(Number(value)).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCsvMoney(value?: number) {
  return Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getChargePaidAmount(charge: Pick<cobranca.Cobranca, "valor" | "valor_pago">) {
  const total = Number(charge.valor || 0);
  const paid = Number(charge.valor_pago || 0);
  return Math.max(0, Math.min(total, Math.round(paid * 100) / 100));
}

function getChargeOpenAmountForExport(
  charge: Pick<cobranca.Cobranca, "status" | "valor" | "valor_pago">
) {
  if (charge.status === "PAGO" || charge.status === "CANCELADO") {
    return 0;
  }

  return Math.max(
    0,
    Math.round((Number(charge.valor || 0) - getChargePaidAmount(charge)) * 100) / 100
  );
}

function formatBillingTypeLabel(type?: string) {
  const map: Record<string, string> = {
    PIX: "Pix",
    BOLETO: "Boleto",
    CARTAO: "Cartão",
    TRANSFERENCIA: "Transferência",
    DINHEIRO: "Dinheiro",
    OUTRO: "Outro",
  };
  return map[String(type || "").trim()] || String(type || "");
}

function formatChargeStatusLabel(status?: string) {
  const map: Record<string, string> = {
    PENDENTE: "Pendente",
    PAGO: "Pago",
    VENCIDO: "Vencido",
    CANCELADO: "Cancelado",
    PARCIAL: "Parcial",
  };
  return map[String(status || "").trim()] || String(status || "");
}

function formatWhatsappTypeLabel(type?: string) {
  const map: Record<string, string> = {
    criacao: "Nova cobrança",
    lembrete_vencimento: "Lembrete de vencimento",
    atraso: "Cobrança em atraso",
    confirmacao_pagamento: "Confirmação de pagamento",
    cancelamento: "Cancelamento",
  };
  return map[String(type || "").trim()] || "";
}

function formatWhatsappStatusLabel(status?: string) {
  const map: Record<string, string> = {
    SENT: "Enviada",
    DELIVERED: "Entregue",
    READ: "Lida",
    FAILED: "Falhou",
  };
  return map[String(status || "").trim()] || "";
}

function getWhatsappStatusTimestamp(charge: cobranca.Cobranca) {
  return (
    Number(charge.whatsapp_ultimo_lido_em || 0) ||
    Number(charge.whatsapp_ultimo_entregue_em || 0) ||
    Number(charge.whatsapp_ultimo_envio_em || 0) ||
    Number(charge.whatsapp_ultimo_status_em || 0)
  );
}

function formatInstallmentLabel(charge: Pick<cobranca.Cobranca, "parcelas" | "parcela_atual">) {
  const parcelas = Number(charge.parcelas || 1);
  const parcelaAtual = Number(charge.parcela_atual || 0);

  if (parcelas <= 1) return "";
  if (parcelaAtual > 0) return `${parcelaAtual}/${parcelas}`;
  return `0/${parcelas}`;
}

function escapeCsvCell(value: unknown) {
  let text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, " ")
    .trim();

  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function buildCobrancasCsv(charges: cobranca.Cobranca[]) {
  const header = [
    "ID",
    "Cliente",
    "Telefone",
    "Forma de pagamento",
    "Descrição",
    "Valor",
    "Valor pago",
    "Saldo em aberto",
    "Vencimento",
    "Status",
    "Recorrente",
    "Parcela",
    "Último envio WhatsApp",
    "Status do WhatsApp",
    "Atualização WhatsApp",
    "Criada em",
  ];

  const rows = charges.map((charge) => [
    String(Number(charge.id || 0)),
    charge.cliente_nome || "",
    charge.cliente_telefone || "",
    formatBillingTypeLabel(charge.billing_type),
    charge.descricao || "",
    formatCsvMoney(charge.valor),
    formatCsvMoney(getChargePaidAmount(charge)),
    formatCsvMoney(getChargeOpenAmountForExport(charge)),
    formatCsvDate(charge.vencimento),
    formatChargeStatusLabel(charge.status),
    charge.recorrente ? "Sim" : "Não",
    formatInstallmentLabel(charge),
    formatWhatsappTypeLabel(charge.whatsapp_ultimo_tipo),
    formatWhatsappStatusLabel(charge.whatsapp_ultimo_status),
    formatCsvDateTime(getWhatsappStatusTimestamp(charge)),
    formatCsvDateTime(charge.created_at),
  ]);

  return `\uFEFF${[header, ...rows]
    .map((columns) => columns.map(escapeCsvCell).join(";"))
    .join("\r\n")}`;
}

function getChargeCsvFilename(baseDate = new Date()) {
  const year = baseDate.getFullYear();
  const month = String(baseDate.getMonth() + 1).padStart(2, "0");
  const day = String(baseDate.getDate()).padStart(2, "0");
  return `cobrancas-${year}-${month}-${day}.csv`;
}

type BulkChargeResult = {
  id: number;
  ok: boolean;
  error?: string;
  tipo?: "atraso" | "lembrete_vencimento";
  whatsapp?: { ok: boolean; error?: string };
};

function buildBulkChargeResponse(results: BulkChargeResult[]) {
  const successCount = results.filter((item) => item.ok).length;
  const failures = results
    .filter((item) => !item.ok)
    .map((item) => ({
      id: item.id,
      error: item.error || "Falha ao processar cobrança",
    }));

  return {
    ok: successCount > 0,
    total: results.length,
    successCount,
    failureCount: failures.length,
    failures,
    results,
  };
}

function getBulkReminderType(status: cobranca.ChargeStatus) {
  if (status === "VENCIDO") return "atraso";
  if (status === "PENDENTE") return "lembrete_vencimento";
  return null;
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

router.get("/api/cobrancas/health", async (req, res) => {
  try {
    const health = await cobranca.getFinancialHealth(getUserId(req));
    return res.json({ ok: true, health });
  } catch (error) {
    console.error("Erro ao carregar saÃºde financeira de cobranÃ§as:", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao carregar saÃºde financeira",
    });
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

router.get("/api/cobrancas/clientes/:id/dashboard", async (req, res) => {
  try {
    const clienteId = parseId(req.params.id);
    if (!clienteId) {
      return res.status(400).json({ ok: false, error: "ID do cliente invÃ¡lido" });
    }

    const dashboard = await cobranca.buscarDashboardCliente(getUserId(req), clienteId);
    if (!dashboard) {
      return res.status(404).json({ ok: false, error: "Cliente nÃ£o encontrado" });
    }

    return res.json({ ok: true, dashboard });
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao carregar dashboard do cliente"),
    });
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
      ...getChargeListFilters(req),
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

router.get("/api/cobrancas/exportar", async (req, res) => {
  try {
    const charges = await cobranca.listarCobrancasParaExportacao(
      getUserId(req),
      getChargeListFilters(req)
    );
    const csv = buildCobrancasCsv(charges);
    const filename = getChargeCsvFilename();

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );

    return res.status(200).send(csv);
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao exportar cobranças"),
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

    const detalhes = await cobranca.buscarCobrancaDetalhada(getUserId(req), cobrancaId);
    if (!detalhes) {
      return res.status(404).json({ ok: false, error: "Cobrança não encontrada" });
    }

    return res.json({ ok: true, ...detalhes });
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

router.post("/api/cobrancas/lote/pagar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const ids = parseIdList(req.body?.ids);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "Selecione pelo menos uma cobrança válida" });
    }

    const results: BulkChargeResult[] = [];

    for (const cobrancaId of ids) {
      try {
        const item = await cobranca.marcarComoPago(
          userId,
          cobrancaId,
          req.body?.valor_pago,
          req.body?.pago_em
        );

        let whatsapp: { ok: boolean; error?: string } | undefined;
        if (req.body?.enviar_confirmacao === true && item.status === "PAGO") {
          whatsapp = await cobranca.enviarNotificacaoWhatsApp(
            userId,
            item,
            "confirmacao_pagamento"
          );
        }

        io.to(`user:${userId}`).emit(
          item.status === "PAGO" ? "cobranca:paga" : "cobranca:atualizada",
          item
        );
        results.push({ id: cobrancaId, ok: true, whatsapp });
      } catch (error) {
        results.push({
          id: cobrancaId,
          ok: false,
          error: getErrorMessage(error, "Erro ao confirmar pagamento"),
        });
      }
    }

    const payload = buildBulkChargeResponse(results);
    return res.status(payload.ok ? 200 : 400).json(payload);
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao confirmar pagamentos em lote"),
    });
  }
});

router.post("/api/cobrancas/lote/cancelar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const ids = parseIdList(req.body?.ids);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "Selecione pelo menos uma cobrança válida" });
    }

    const results: BulkChargeResult[] = [];

    for (const cobrancaId of ids) {
      try {
        const item = await cobranca.buscarCobranca(userId, cobrancaId);
        if (!item) {
          throw new Error("Cobrança não encontrada");
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
        results.push({ id: cobrancaId, ok: true, whatsapp });
      } catch (error) {
        results.push({
          id: cobrancaId,
          ok: false,
          error: getErrorMessage(error, "Erro ao cancelar cobrança"),
        });
      }
    }

    const payload = buildBulkChargeResponse(results);
    return res.status(payload.ok ? 200 : 400).json(payload);
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao cancelar cobranças em lote"),
    });
  }
});

router.post("/api/cobrancas/lote/notificar", async (req, res) => {
  try {
    const userId = getUserId(req);
    const ids = parseIdList(req.body?.ids);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: "Selecione pelo menos uma cobrança válida" });
    }

    const results: BulkChargeResult[] = [];

    for (const cobrancaId of ids) {
      try {
        const item = await cobranca.buscarCobranca(userId, cobrancaId);
        if (!item) {
          throw new Error("Cobrança não encontrada");
        }

        const tipo = getBulkReminderType(item.status);
        if (!tipo) {
          throw new Error("Somente cobranças pendentes ou vencidas podem receber lembrete.");
        }

        const result = await cobranca.enviarNotificacaoWhatsApp(userId, item, tipo);
        if (!result.ok) {
          throw new Error(result.error || "Erro ao enviar notificação");
        }

        const updated = await cobranca.buscarCobranca(userId, cobrancaId);
        if (updated) {
          io.to(`user:${userId}`).emit("cobranca:atualizada", updated);
        }

        results.push({ id: cobrancaId, ok: true, tipo });
      } catch (error) {
        results.push({
          id: cobrancaId,
          ok: false,
          error: getErrorMessage(error, "Erro ao enviar notificação"),
        });
      }
    }

    const payload = buildBulkChargeResponse(results);
    return res.status(payload.ok ? 200 : 400).json(payload);
  } catch (error) {
    const status = getErrorStatus(error);
    return res.status(status).json({
      ok: false,
      error: getErrorMessage(error, "Erro ao enviar notificações em lote"),
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
      req.body?.pago_em,
      req.body?.observacao
    );

    let whatsapp: { ok: boolean; error?: string } | undefined;
    if (req.body?.enviar_confirmacao !== false && item.status === "PAGO") {
      whatsapp = await cobranca.enviarNotificacaoWhatsApp(
        userId,
        item,
        "confirmacao_pagamento"
      );
    }

    io.to(`user:${userId}`).emit(
      item.status === "PAGO" ? "cobranca:paga" : "cobranca:atualizada",
      item
    );

    return res.json({
      ok: true,
      cobranca: item,
      resumo: {
        total_recebido: Number(item.valor_pago || 0),
        saldo_aberto: Math.max(
          0,
          Number(item.valor || 0) - Number(item.valor_pago || 0)
        ),
      },
      parcial: item.status === "PARCIAL",
      whatsapp,
    });
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
