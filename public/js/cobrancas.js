const State = {
  cobrancas: [],
  total: 0,
  pages: 1,
  page: 1,
  recorrencias: [],
  clientes: [],
  sessoes: [],
  currentDetalhesId: null,
  currentTab: "cobrancas",
};

const ACCOUNT_DEFAULTS = loadCobrancaAccountDefaults();

let socket = null;
let searchDebounce = null;
let searchClienteDebounce = null;
let realtimeRefreshTimer = null;

window.onload = async () => {
  setDefaultVencimento();
  initSocket();
  syncBillingTypeSections();

  await Promise.allSettled([
    loadSummary(),
    loadCobrancas(),
    loadRecorrencias(),
    loadClientes(),
    loadSessoes(),
  ]);

  bindInputListeners();
};

function initSocket() {
  try {
    socket = io();
    [
      "cobranca:nova",
      "cobranca:paga",
      "cobranca:cancelada",
      "cobranca:atualizada",
      "cobranca:cliente",
      "cobranca:recorrencia",
    ].forEach((eventName) => {
      socket.on(eventName, scheduleRealtimeRefresh);
    });

    socket.on("sessions:changed", () => {
      loadSessoes();
    });
  } catch (err) {
    console.warn("Socket de cobranças indisponível:", err);
  }
}

function scheduleRealtimeRefresh() {
  clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(() => {
    Promise.all([
      loadSummary(),
      loadCobrancas(),
      loadRecorrencias(),
      loadClientes(),
    ]).catch((err) => console.warn("Falha no refresh em tempo real:", err));
  }, 180);
}

function switchTab(nome) {
  State.currentTab = nome;

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === nome);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${nome}`);
  });

  if (nome === "clientes") {
    loadClientes();
  } else if (nome === "recorrencias") {
    loadRecorrencias();
  } else {
    loadCobrancas();
  }
}

async function loadSummary() {
  try {
    const res = await fetch("/api/cobrancas/summary");
    const data = await res.json();
    if (!data.ok) return;
    renderSummaryCards(data.summary);
  } catch (err) {
    console.warn("Erro ao carregar summary de cobranças:", err);
  }
}

function renderSummaryCards(s) {
  const wrap = document.getElementById("summaryCards");
  if (!wrap) return;

  wrap.innerHTML = `
    <div class="summary-card card-pendente">
      <div class="summary-card-icon">
        <i class="fa-solid fa-hourglass-half"></i>
      </div>
      <div class="summary-card-body">
        <div class="summary-card-value" data-summary="valor_pendente">R$ 0,00</div>
        <div class="summary-card-label">Total pendente</div>
        <div class="summary-card-meta">${Number(s.total_pendente || 0)} cobrança(s) abertas</div>
      </div>
    </div>
    <div class="summary-card card-pago">
      <div class="summary-card-icon">
        <i class="fa-solid fa-circle-check"></i>
      </div>
      <div class="summary-card-body">
        <div class="summary-card-value" data-summary="valor_pago_mes">R$ 0,00</div>
        <div class="summary-card-label">Recebido este mês</div>
        <div class="summary-card-meta">${Number(s.total_pago || 0)} cobrança(s) pagas</div>
      </div>
    </div>
    <div class="summary-card card-vencido">
      <div class="summary-card-icon">
        <i class="fa-solid fa-triangle-exclamation"></i>
      </div>
      <div class="summary-card-body">
        <div class="summary-card-value" data-summary="valor_vencido">R$ 0,00</div>
        <div class="summary-card-label">Em atraso</div>
        <div class="summary-card-meta">${Number(s.total_vencido || 0)} cobrança(s) vencidas</div>
      </div>
    </div>
    <div class="summary-card card-clientes">
      <div class="summary-card-icon">
        <i class="fa-solid fa-users"></i>
      </div>
      <div class="summary-card-body">
        <div class="summary-card-value" data-summary="total_clientes">0</div>
        <div class="summary-card-label">Clientes ativos</div>
        <div class="summary-card-meta">${Number(s.total_recorrencias_ativas || 0)} recorrência(s) ativa(s)</div>
      </div>
    </div>
  `;

  animateValue(wrap.querySelector('[data-summary="valor_pendente"]'), Number(s.valor_pendente || 0), "R$ ");
  animateValue(wrap.querySelector('[data-summary="valor_pago_mes"]'), Number(s.valor_pago_mes || 0), "R$ ");
  animateValue(wrap.querySelector('[data-summary="valor_vencido"]'), Number(s.valor_vencido || 0), "R$ ");
  animateValue(wrap.querySelector('[data-summary="total_clientes"]'), Number(s.total_clientes || 0));
}

function animateValue(el, end, prefix = "") {
  if (!el) return;

  const duration = 700;
  const start = 0;
  const isCurrency = prefix === "R$ ";
  const safeEnd = Number(end || 0);
  const startTime = performance.now();

  function formatValue(value) {
    if (isCurrency) {
      return `R$ ${Number(value || 0).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }

    return `${prefix}${Math.round(value).toLocaleString("pt-BR")}`;
  }

  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const current = start + (safeEnd - start) * progress;
    el.textContent = formatValue(current);

    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      el.textContent = formatValue(safeEnd);
    }
  }

  requestAnimationFrame(tick);
}

async function loadCobrancas() {
  const tbody = document.getElementById("cobrancasTableBody");
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="table-loading">Carregando cobranças...</td>
      </tr>
    `;
  }

  const status = document.getElementById("filtroStatus")?.value || "all";
  const search = document.getElementById("filtroBusca")?.value.trim() || "";
  const from = document.getElementById("filtroFrom")?.value || "";
  const to = document.getElementById("filtroTo")?.value || "";

  const qs = new URLSearchParams({
    status,
    search,
    from,
    to,
    page: String(State.page),
    pageSize: "15",
  });

  try {
    const res = await fetch(`/api/cobrancas/listar?${qs.toString()}`);
    const data = await res.json();
    if (!data.ok) {
      showToast("error", data.error || "Erro ao carregar cobranças");
      return;
    }

    const requestedPage = State.page;
    State.cobrancas = Array.isArray(data.charges) ? data.charges : [];
    State.total = Number(data.total || 0);
    State.pages = Math.max(1, Number(data.pages || 1));
    if (requestedPage > State.pages && State.total > 0) {
      State.page = State.pages;
      await loadCobrancas();
      return;
    }

    renderCobrancasTable();
    renderPaginacao();
  } catch (err) {
    console.error(err);
    showToast("error", "Erro de conexão ao carregar cobranças");
  }
}

function renderCobrancasTable() {
  const tbody = document.getElementById("cobrancasTableBody");
  if (!tbody) return;

  if (!State.cobrancas.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state-cob">
            <i class="fa-solid fa-file-invoice"></i>
            <p>Nenhuma cobrança encontrada</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = State.cobrancas
    .map((c) => `
      <tr>
        <td>
          <div class="cliente-cell">
            <strong>${escHtml(c.cliente_nome)}</strong>
            <div class="cliente-subinfo">${escHtml(formatPhoneDisplay(c.cliente_telefone))}</div>
          </div>
        </td>
        <td>${formatBillingType(c.billing_type)}</td>
        <td class="valor-col">${formatCurrency(c.valor)}</td>
        <td>
          ${formatDate(c.vencimento)}
          ${Number(c.parcelas) > 1 && Number(c.parcela_atual) > 0
            ? `<div class="cliente-subinfo">${Number(c.parcela_atual)}/${Number(c.parcelas)}x</div>`
            : ""}
        </td>
        <td><span class="badge-status badge-${c.status}">${formatStatus(c.status)}</span></td>
        <td>
          <div class="table-actions">
            <button class="btn-table-action" title="Ver detalhes" onclick="abrirDetalhes(${Number(c.id)})">
              <i class="fa-solid fa-eye"></i>
            </button>
            ${(c.status === "PENDENTE" || c.status === "VENCIDO")
              ? `
                <button class="btn-table-action success" title="Marcar como pago" onclick="abrirModalPagar(${Number(c.id)})">
                  <i class="fa-solid fa-check"></i>
                </button>
              `
              : ""}
            <button class="btn-table-action whatsapp" title="Enviar WhatsApp" onclick="enviarWhatsAppManual(${Number(c.id)})">
              <i class="fa-brands fa-whatsapp"></i>
            </button>
            ${c.status === "PENDENTE"
              ? `
                <button class="btn-table-action danger" title="Cancelar" onclick="cancelarCobranca(${Number(c.id)})">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              `
              : ""}
          </div>
        </td>
      </tr>
    `)
    .join("");
}

function abrirModalNovaCobranca() {
  limparFormCobranca();
  abrirModal("modalNovaCobranca");
}

function limparFormCobranca() {
  const form = document.getElementById("formNovaCobranca");
  form?.reset();
  setDefaultVencimento();
  setPhoneInputValue("cbTelefone");
  document.getElementById("cbParcelas").value = "1";
  document.getElementById("cbCycle").value = "MENSAL";
  document.getElementById("cbEnviarWpp").checked = false;
  document.getElementById("cbRecorrente").checked = false;
  document.getElementById("wppSection").style.display = "none";
  document.getElementById("recorrenciaSection").style.display = "none";
  applyBillingDefaults("cb");
  setSessionSelectValue("cbSession", ACCOUNT_DEFAULTS.defaultSessionName);
  document.getElementById("wppPreview").textContent = "Preencha os dados acima para ver o preview...";
  clearAllFieldErrors(form || document);
  syncBillingTypeSections();
}

async function criarCobranca() {
  const btn = document.getElementById("btnCriarCobranca");
  const form = document.getElementById("formNovaCobranca");
  clearAllFieldErrors(form || document);

  const nome = document.getElementById("cbNome").value.trim();
  const telefone = document.getElementById("cbTelefone").value.trim();
  const valor = parseCurrencyInput(document.getElementById("cbValor").value);
  const vencimento = document.getElementById("cbVencimento").value;
  const descricao = document.getElementById("cbDescricao").value.trim();
  const recorrente = document.getElementById("cbRecorrente").checked;
  const parcelas = Number(document.getElementById("cbParcelas").value || 1);
  const dataFim = document.getElementById("cbDataFim").value;

  let hasError = false;
  if (!nome) {
    showFieldError("cbNome", "Nome obrigatório");
    hasError = true;
  }
  if (!telefone) {
    showFieldError("cbTelefone", "Telefone obrigatório");
    hasError = true;
  }
  if (telefone && !isValidBrazilPhone(telefone)) {
    showFieldError("cbTelefone", `Informe um WhatsApp com DDI ${PHONE_BR_PREFIX} e DDD`);
    hasError = true;
  }
  if (!valor || valor <= 0) {
    showFieldError("cbValor", "Valor inválido");
    hasError = true;
  }
  if (!vencimento) {
    showFieldError("cbVencimento", "Vencimento obrigatório");
    hasError = true;
  }
  if (!descricao) {
    showFieldError("cbDescricao", "Descrição obrigatória");
    hasError = true;
  }
  if (recorrente && parcelas > 1) {
    showFieldError("cbParcelas", "Recorrência não pode ser parcelada");
    hasError = true;
  }
  if (dataFim && vencimento && dataFim < vencimento) {
    showFieldError("cbDataFim", "A data final deve ser igual ou maior que o primeiro vencimento");
    hasError = true;
  }
  if (hasError) return;

  const payload = {
    nome,
    telefone,
    email: document.getElementById("cbEmail").value.trim(),
    cpf_cnpj: document.getElementById("cbCpfCnpj").value.trim(),
    billing_type: document.getElementById("cbBillingType").value,
    valor,
    vencimento,
    descricao,
    observacoes: document.getElementById("cbObservacoes").value.trim(),
    chave_pix: document.getElementById("cbChavePix").value.trim(),
    link_pagamento: document.getElementById("cbLinkPagamento").value.trim(),
    parcelas,
    multa_percentual: Number(document.getElementById("cbMulta").value) || 0,
    juros_percentual: Number(document.getElementById("cbJuros").value) || 0,
    desconto_percentual: Number(document.getElementById("cbDesconto").value) || 0,
    desconto_limite_dias: Number(document.getElementById("cbDescontoDias").value) || 0,
    recorrente,
    cycle: document.getElementById("cbCycle").value,
    data_fim: dataFim,
    enviar_whatsapp: document.getElementById("cbEnviarWpp").checked,
    session_name: document.getElementById("cbSession").value,
  };

  setButtonLoading(btn, true, "Gerando...");

  try {
    const res = await fetch("/api/cobrancas/criar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao criar cobrança");
      return;
    }

    const parcelaMsg = Array.isArray(data.parcelamentos) && data.parcelamentos.length > 1
      ? ` ${data.parcelamentos.length} parcelas geradas.`
      : "";
    showToast("success", `Cobrança criada com sucesso!${parcelaMsg}`);

    if (data.whatsapp && data.whatsapp.ok === false) {
      showToast("warn", data.whatsapp.error || "Cobrança criada, mas não foi possível enviar no WhatsApp.");
    }

    fecharModal("modalNovaCobranca");
    await Promise.all([loadSummary(), loadCobrancas(), loadRecorrencias(), loadClientes()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro de conexão");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function abrirDetalhes(id) {
  State.currentDetalhesId = id;
  abrirModal("modalDetalhes");

  const content = document.getElementById("detalhesContent");
  const footer = document.getElementById("detalhesBtns");
  content.innerHTML = `<div class="table-loading">Carregando detalhes...</div>`;
  footer.innerHTML = "";

  try {
    const res = await fetch(`/api/cobrancas/${id}`);
    const data = await res.json();
    if (!data.ok) {
      content.innerHTML = `<div class="table-loading">${escHtml(data.error || "Erro ao carregar detalhes")}</div>`;
      return;
    }

    const c = data.cobranca;
    const valorPago = c.valor_pago ? formatCurrency(c.valor_pago) : "—";

    content.innerHTML = `
      <div class="detalhe-grid">
        <div class="detalhe-item">
          <label>Cliente</label>
          <strong>${escHtml(c.cliente_nome)}</strong>
        </div>
        <div class="detalhe-item">
          <label>Telefone</label>
          <strong>${escHtml(formatPhoneDisplay(c.cliente_telefone))}</strong>
        </div>
        <div class="detalhe-item">
          <label>Valor</label>
          <strong style="color:var(--success);font-size:20px">${formatCurrency(c.valor)}</strong>
        </div>
        <div class="detalhe-item">
          <label>Valor pago</label>
          <strong>${valorPago}</strong>
        </div>
        <div class="detalhe-item">
          <label>Vencimento</label>
          <strong>${formatDate(c.vencimento)}</strong>
        </div>
        <div class="detalhe-item">
          <label>Status</label>
          <span class="badge-status badge-${c.status}">${formatStatus(c.status)}</span>
        </div>
        <div class="detalhe-item">
          <label>Forma de pagamento</label>
          <strong>${formatBillingType(c.billing_type)}</strong>
        </div>
        <div class="detalhe-item">
          <label>Recorrência</label>
          <strong>${c.recorrente ? "Sim" : "Não"}</strong>
        </div>
        ${Number(c.parcelas) > 1 && Number(c.parcela_atual) > 0
          ? `
            <div class="detalhe-item">
              <label>Parcela</label>
              <strong>${Number(c.parcela_atual)} de ${Number(c.parcelas)}</strong>
            </div>
          `
          : ""}
        ${c.pago_em
          ? `
            <div class="detalhe-item">
              <label>Pago em</label>
              <strong>${new Date(Number(c.pago_em)).toLocaleDateString("pt-BR")}</strong>
            </div>
          `
          : ""}
      </div>

      <div class="detalhe-item" style="margin-bottom:14px;">
        <label>Descrição</label>
        <p style="margin:4px 0;color:var(--text)">${escHtml(c.descricao)}</p>
      </div>

      ${c.observacoes
        ? `
          <div class="detalhe-item" style="margin-bottom:14px;">
            <label>Observações</label>
            <p style="margin:4px 0;color:var(--text)">${escHtml(c.observacoes)}</p>
          </div>
        `
        : ""}

      ${c.chave_pix
        ? `
          <div style="margin-bottom:14px;">
            <label style="font-size:11px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:6px;">
              Chave PIX
            </label>
            <div class="copy-line">
              <span class="copy-line-text">${escHtml(c.chave_pix)}</span>
              <button class="copy-btn" onclick='copyToClipboard(${quoteJs(c.chave_pix)})'>
                <i class="fa-solid fa-copy"></i> Copiar
              </button>
            </div>
          </div>
        `
        : ""}

      ${c.link_pagamento
        ? `
          <div style="margin-bottom:14px;">
            <label style="font-size:11px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:6px;">
              Link de pagamento
            </label>
            <div class="copy-line">
              <span class="copy-line-text">${escHtml(c.link_pagamento)}</span>
              <button class="copy-btn" onclick='copyToClipboard(${quoteJs(c.link_pagamento)})'>
                <i class="fa-solid fa-copy"></i> Copiar
              </button>
            </div>
          </div>
        `
        : ""}
    `;

    footer.innerHTML = `
      <button class="btn-ghost-cob" onclick="fecharModal('modalDetalhes')">Fechar</button>
      <button class="btn-ghost-cob" onclick="enviarWhatsAppManual(${Number(c.id)})">
        <i class="fa-brands fa-whatsapp"></i> Enviar WPP
      </button>
      ${(c.status === "PENDENTE" || c.status === "VENCIDO")
        ? `
          <button class="btn-primary-cob" onclick="fecharModal('modalDetalhes');abrirModalPagar(${Number(c.id)})">
            <i class="fa-solid fa-check"></i> Marcar como pago
          </button>
        `
        : ""}
      ${c.status === "PENDENTE"
        ? `
          <button class="btn-ghost-cob" onclick="fecharModal('modalDetalhes');cancelarCobranca(${Number(c.id)})">
            <i class="fa-solid fa-ban"></i> Cancelar
          </button>
        `
        : ""}
    `;
  } catch (err) {
    console.error(err);
    content.innerHTML = `<div class="table-loading">Erro ao carregar detalhes</div>`;
  }
}

function abrirModalPagar(id) {
  document.getElementById("pagarCobrancaId").value = id;
  document.getElementById("pagarData").value = formatDateInputLocal(new Date());
  document.getElementById("pagarValor").value = "";
  document.getElementById("pagarEnviarConfirmacao").checked = true;
  abrirModal("modalPagar");
}

async function confirmarPagamento() {
  const id = document.getElementById("pagarCobrancaId").value;
  const valorPagoRaw = document.getElementById("pagarValor").value;
  const valorPago = valorPagoRaw ? parseCurrencyInput(valorPagoRaw) : null;
  const pagoEm = document.getElementById("pagarData").value;
  const enviarConfirmacao = document.getElementById("pagarEnviarConfirmacao").checked;
  const btn = document.getElementById("btnConfirmarPagamento");

  setButtonLoading(btn, true, "Confirmando...");

  try {
    const res = await fetch(`/api/cobrancas/${id}/pagar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        valor_pago: valorPago,
        pago_em: pagoEm,
        enviar_confirmacao: enviarConfirmacao,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao confirmar pagamento");
      return;
    }

    showToast("success", "Pagamento confirmado!");
    if (data.whatsapp && data.whatsapp.ok === false) {
      showToast("warn", data.whatsapp.error || "Pagamento confirmado, mas o WhatsApp não foi enviado.");
    }

    fecharModal("modalPagar");
    await Promise.all([loadSummary(), loadCobrancas(), loadRecorrencias()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro de conexão");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function cancelarCobranca(id) {
  if (!confirm("Cancelar esta cobrança?")) return;

  try {
    const res = await fetch(`/api/cobrancas/${id}/cancelar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enviar_whatsapp: false }),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao cancelar cobrança");
      return;
    }

    showToast("success", "Cobrança cancelada");
    await Promise.all([loadSummary(), loadCobrancas(), loadRecorrencias()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao cancelar cobrança");
  }
}

async function enviarWhatsAppManual(id) {
  const charge = State.cobrancas.find((item) => Number(item.id) === Number(id));
  const tipo =
    charge?.status === "VENCIDO"
      ? "atraso"
      : charge?.status === "PENDENTE"
        ? "lembrete_vencimento"
        : "criacao";

  try {
    const res = await fetch(`/api/cobrancas/${id}/notificar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo }),
    });
    const data = await res.json();

    if (data.ok) {
      showToast("success", "Mensagem enviada via WhatsApp!");
      if (State.currentDetalhesId === Number(id)) {
        abrirDetalhes(Number(id));
      }
    } else {
      showToast("error", data.error || "Erro ao enviar. Verifique a sessão WPP.");
    }
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao enviar WhatsApp");
  }
}

async function loadRecorrencias() {
  const tbody = document.getElementById("recorrenciasTableBody");
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="table-loading">Carregando recorrências...</td>
      </tr>
    `;
  }

  try {
    const res = await fetch("/api/cobrancas/recorrencias/listar");
    const data = await res.json();
    if (!data.ok) return;
    State.recorrencias = Array.isArray(data.recorrencias) ? data.recorrencias : [];
    renderRecorrenciasTable();
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao carregar recorrências");
  }
}

function renderRecorrenciasTable() {
  const tbody = document.getElementById("recorrenciasTableBody");
  if (!tbody) return;

  if (!State.recorrencias.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state-cob">
            <i class="fa-solid fa-rotate"></i>
            <p>Nenhuma recorrência cadastrada</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = State.recorrencias
    .map((r) => `
      <tr>
        <td>
          <div class="cliente-cell">
            <strong>${escHtml(r.cliente_nome)}</strong>
            <div class="cliente-subinfo">${escHtml(r.session_name || "Sem sessão definida")}</div>
          </div>
        </td>
        <td>${formatCycle(r.cycle)}</td>
        <td class="valor-col">${formatCurrency(r.valor)}</td>
        <td>${formatDate(r.proxima_cobranca)}</td>
        <td>
          <span class="badge-status badge-${r.ativa ? "PAGO" : "CANCELADO"}">
            ${r.ativa ? "Ativa" : "Pausada"}
          </span>
        </td>
        <td>
          <div class="table-actions">
            ${r.ativa
              ? `
                <button class="btn-table-action danger" title="Pausar" onclick="pausarRecorrencia(${Number(r.id)})">
                  <i class="fa-solid fa-pause"></i>
                </button>
              `
              : `
                <button class="btn-table-action success" title="Reativar" onclick="reativarRecorrencia(${Number(r.id)})">
                  <i class="fa-solid fa-play"></i>
                </button>
              `}
          </div>
        </td>
      </tr>
    `)
    .join("");
}

async function pausarRecorrencia(id) {
  if (!confirm("Pausar esta recorrência?")) return;

  try {
    const res = await fetch(`/api/cobrancas/recorrencias/${id}/pausar`, { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      showToast("error", data.error || "Erro ao pausar");
      return;
    }
    showToast("success", "Recorrência pausada");
    await Promise.all([loadRecorrencias(), loadSummary()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao pausar recorrência");
  }
}

async function reativarRecorrencia(id) {
  try {
    const res = await fetch(`/api/cobrancas/recorrencias/${id}/reativar`, { method: "POST" });
    const data = await res.json();
    if (!data.ok) {
      showToast("error", data.error || "Erro ao reativar");
      return;
    }
    showToast("success", "Recorrência reativada");
    await Promise.all([loadRecorrencias(), loadSummary()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao reativar recorrência");
  }
}

function abrirModalNovaRecorrencia() {
  limparFormRecorrencia();
  abrirModal("modalNovaRecorrencia");
}

function limparFormRecorrencia() {
  const form = document.getElementById("formNovaRecorrencia");
  form?.reset();
  setPhoneInputValue("rcTelefone");
  document.getElementById("rcCycle").value = "MENSAL";
  document.getElementById("rcEnviarWpp").checked = false;
  document.getElementById("rcWppSection").style.display = "none";
  applyBillingDefaults("rc");
  setSessionSelectValue("rcSession", ACCOUNT_DEFAULTS.defaultSessionName);
  document.getElementById("rcWppPreview").textContent = "Preencha os dados acima para ver o preview...";
  setDefaultVencimento("rcVencimento");
  clearAllFieldErrors(form || document);
  syncBillingTypeSections();
}

async function criarRecorrencia() {
  const btn = document.getElementById("btnCriarRecorrencia");
  const form = document.getElementById("formNovaRecorrencia");
  clearAllFieldErrors(form || document);

  const nome = document.getElementById("rcNome").value.trim();
  const telefone = document.getElementById("rcTelefone").value.trim();
  const valor = parseCurrencyInput(document.getElementById("rcValor").value);
  const vencimento = document.getElementById("rcVencimento").value;
  const descricao = document.getElementById("rcDescricao").value.trim();
  const dataFim = document.getElementById("rcDataFim").value;

  let hasError = false;
  if (!nome) {
    showFieldError("rcNome", "Nome obrigatório");
    hasError = true;
  }
  if (!telefone) {
    showFieldError("rcTelefone", "Telefone obrigatório");
    hasError = true;
  }
  if (!valor || valor <= 0) {
    showFieldError("rcValor", "Valor inválido");
    hasError = true;
  }
  if (!vencimento) {
    showFieldError("rcVencimento", "Primeiro vencimento obrigatório");
    hasError = true;
  }
  if (!descricao) {
    showFieldError("rcDescricao", "Descrição obrigatória");
    hasError = true;
  }
  if (dataFim && vencimento && dataFim < vencimento) {
    showFieldError("rcDataFim", "A data final deve ser igual ou maior que o primeiro vencimento");
    hasError = true;
  }
  if (telefone && !isValidBrazilPhone(telefone)) {
    showFieldError("rcTelefone", `Informe um WhatsApp com DDI ${PHONE_BR_PREFIX} e DDD`);
    hasError = true;
  }
  if (hasError) return;

  const payload = {
    nome,
    telefone,
    email: document.getElementById("rcEmail").value.trim(),
    cpf_cnpj: document.getElementById("rcCpfCnpj").value.trim(),
    billing_type: document.getElementById("rcBillingType").value,
    valor,
    vencimento,
    descricao,
    observacoes: document.getElementById("rcObservacoes").value.trim(),
    chave_pix: document.getElementById("rcChavePix").value.trim(),
    link_pagamento: document.getElementById("rcLinkPagamento").value.trim(),
    parcelas: 1,
    recorrente: true,
    cycle: document.getElementById("rcCycle").value,
    data_fim: dataFim,
    multa_percentual: Number(getBillingDefaults().multa_percentual || 0),
    juros_percentual: Number(getBillingDefaults().juros_percentual || 0),
    desconto_percentual: Number(getBillingDefaults().desconto_percentual || 0),
    desconto_limite_dias: Number(getBillingDefaults().desconto_limite_dias || 0),
    enviar_whatsapp: document.getElementById("rcEnviarWpp").checked,
    session_name: document.getElementById("rcSession").value,
  };

  setButtonLoading(btn, true, "Criando...");

  try {
    const res = await fetch("/api/cobrancas/criar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao criar recorrência");
      return;
    }

    showToast("success", "Recorrência criada com sucesso!");
    if (data.whatsapp && data.whatsapp.ok === false) {
      showToast("warn", data.whatsapp.error || "Recorrência criada, mas a mensagem não foi enviada.");
    }

    fecharModal("modalNovaRecorrencia");
    switchTab("recorrencias");
    await Promise.all([loadSummary(), loadRecorrencias(), loadCobrancas(), loadClientes()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro de conexão");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function loadClientes(search = "") {
  const tbody = document.getElementById("clientesTableBody");
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="table-loading">Carregando clientes...</td>
      </tr>
    `;
  }

  const term = search || document.getElementById("filtroCliente")?.value?.trim() || "";
  const qs = term ? `?search=${encodeURIComponent(term)}` : "";

  try {
    const res = await fetch(`/api/cobrancas/clientes${qs}`);
    const data = await res.json();
    if (!data.ok) return;
    State.clientes = Array.isArray(data.clientes) ? data.clientes : [];
    renderClientesTable();
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao carregar clientes");
  }
}

function renderClientesTable() {
  const tbody = document.getElementById("clientesTableBody");
  if (!tbody) return;

  if (!State.clientes.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-state-cob">
            <i class="fa-solid fa-users"></i>
            <p>Nenhum cliente encontrado</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = State.clientes
    .map((c) => `
      <tr>
        <td><strong>${escHtml(c.nome)}</strong></td>
        <td>${escHtml(formatPhoneDisplay(c.telefone))}</td>
        <td>${escHtml(c.email || "—")}</td>
        <td>${escHtml(c.cpf_cnpj || "—")}</td>
        <td>
          <div class="table-actions">
            <button class="btn-table-action" title="Editar" onclick="editarCliente(${Number(c.id)})">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="btn-table-action danger" title="Excluir" onclick="deletarCliente(${Number(c.id)})">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `)
    .join("");
}

function abrirModalNovoCliente() {
  limparFormCliente();
  document.getElementById("clienteModalTitle").innerHTML = `<i class="fa-solid fa-user-plus"></i> Novo Cliente`;
  abrirModal("modalCliente");
}

function limparFormCliente() {
  const form = document.getElementById("formCliente");
  form?.reset();
  document.getElementById("clienteId").value = "";
  setPhoneInputValue("clienteTelefone");
  clearAllFieldErrors(form || document);
}

function editarCliente(id) {
  const cliente = State.clientes.find((item) => Number(item.id) === Number(id));
  if (!cliente) return;

  limparFormCliente();
  document.getElementById("clienteId").value = cliente.id;
  document.getElementById("clienteNome").value = cliente.nome || "";
  setPhoneInputValue("clienteTelefone", cliente.telefone || "");
  document.getElementById("clienteEmail").value = cliente.email || "";
  document.getElementById("clienteCpfCnpj").value = cliente.cpf_cnpj || "";
  document.getElementById("clienteObservacoes").value = cliente.observacoes || "";
  document.getElementById("clienteModalTitle").innerHTML = `<i class="fa-solid fa-user-pen"></i> Editar Cliente`;
  abrirModal("modalCliente");
}

async function salvarCliente() {
  const btn = document.getElementById("btnSalvarCliente");
  const form = document.getElementById("formCliente");
  clearAllFieldErrors(form || document);

  const id = document.getElementById("clienteId").value;
  const nome = document.getElementById("clienteNome").value.trim();
  const telefone = document.getElementById("clienteTelefone").value.trim();

  let hasError = false;
  if (!nome) {
    showFieldError("clienteNome", "Nome obrigatório");
    hasError = true;
  }
  if (!telefone) {
    showFieldError("clienteTelefone", "Telefone obrigatório");
    hasError = true;
  }
  if (hasError) return;

  if (telefone && !isValidBrazilPhone(telefone)) {
    showFieldError("clienteTelefone", `Informe um WhatsApp com DDI ${PHONE_BR_PREFIX} e DDD`);
    return;
  }

  const payload = {
    nome,
    telefone,
    email: document.getElementById("clienteEmail").value.trim(),
    cpf_cnpj: document.getElementById("clienteCpfCnpj").value.trim(),
    observacoes: document.getElementById("clienteObservacoes").value.trim(),
  };

  setButtonLoading(btn, true, "Salvando...");

  try {
    const res = await fetch(id ? `/api/cobrancas/clientes/${id}` : "/api/cobrancas/clientes", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao salvar cliente");
      return;
    }

    showToast("success", id ? "Cliente atualizado" : "Cliente cadastrado");
    fecharModal("modalCliente");
    await Promise.all([loadClientes(), loadSummary()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao salvar cliente");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function deletarCliente(id) {
  if (!confirm("Excluir este cliente?")) return;

  try {
    const res = await fetch(`/api/cobrancas/clientes/${id}`, { method: "DELETE" });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao excluir cliente");
      return;
    }

    showToast("success", "Cliente excluído");
    await Promise.all([loadClientes(), loadSummary()]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao excluir cliente");
  }
}

async function loadSessoes() {
  try {
    const res = await fetch("/api/cobrancas/sessoes");
    const data = await res.json();
    if (!data.ok) return;

    State.sessoes = Array.isArray(data.sessoes) ? data.sessoes : [];
    renderSessionSelect("cbSession");
    renderSessionSelect("rcSession");
  } catch (err) {
    console.error(err);
  }
}

function renderSessionSelect(id) {
  const select = document.getElementById(id);
  if (!select) return;
  const previousValue = select.value;

  if (!State.sessoes.length) {
    select.innerHTML = `<option value="">Nenhuma sessão conectada</option>`;
    return;
  }

  select.innerHTML = State.sessoes
    .map((item) => `<option value="${escAttr(item.session_name)}">${escHtml(item.session_name)}</option>`)
    .join("");
  setSessionSelectValue(id, previousValue || ACCOUNT_DEFAULTS.defaultSessionName);
}

function bindInputListeners() {
  bindCurrencyMask(["cbValor", "rcValor", "pagarValor"]);
  bindPhoneMask(["cbTelefone", "rcTelefone", "clienteTelefone"]);

  const cobrancaFields = [
    "cbNome",
    "cbBillingType",
    "cbValor",
    "cbVencimento",
    "cbDescricao",
    "cbChavePix",
    "cbLinkPagamento",
    "cbMulta",
    "cbJuros",
  ];

  cobrancaFields.forEach((id) => {
    document.getElementById(id)?.addEventListener("input", atualizarPreviewWpp);
    document.getElementById(id)?.addEventListener("change", atualizarPreviewWpp);
  });

  const recorrenciaFields = [
    "rcNome",
    "rcBillingType",
    "rcValor",
    "rcVencimento",
    "rcDescricao",
    "rcChavePix",
    "rcLinkPagamento",
    "rcCycle",
    "rcMulta",
    "rcJuros",
  ];

  recorrenciaFields.forEach((id) => {
    document.getElementById(id)?.addEventListener("input", atualizarPreviewRecorrenciaWpp);
    document.getElementById(id)?.addEventListener("change", atualizarPreviewRecorrenciaWpp);
  });

  document.getElementById("cbBillingType")?.addEventListener("change", syncBillingTypeSections);
  document.getElementById("rcBillingType")?.addEventListener("change", syncBillingTypeSections);
}

function atualizarPreviewWpp() {
  const preview = document.getElementById("wppPreview");
  if (!preview || !document.getElementById("cbEnviarWpp")?.checked) return;

  const nome = document.getElementById("cbNome")?.value || "{nome}";
  const valor = parseCurrencyInput(document.getElementById("cbValor")?.value) || 0;
  const venc = document.getElementById("cbVencimento")?.value;
  const tipo = document.getElementById("cbBillingType")?.value || "PIX";
  const desc = document.getElementById("cbDescricao")?.value || "{descrição}";
  const pix = document.getElementById("cbChavePix")?.value;
  const link = document.getElementById("cbLinkPagamento")?.value;
  const multa = Number(document.getElementById("cbMulta")?.value || 0);
  const juros = Number(document.getElementById("cbJuros")?.value || 0);

  const extras = [];
  if (multa > 0) extras.push(`⚠️ *Multa:* ${multa}%`);
  if (juros > 0) extras.push(`📈 *Juros:* ${juros}% ao mês`);

  preview.textContent = buildChargePreviewMessage("criacao", {
    nome,
    primeiro_nome: String(nome || "{nome}").trim().split(/\s+/)[0] || "{nome}",
    valor: valor > 0 ? formatCurrency(valor) : "{valor}",
    valor_pago: valor > 0 ? formatCurrency(valor) : "{valor}",
    vencimento: venc
      ? new Date(`${venc}T12:00:00`).toLocaleDateString("pt-BR")
      : "{data}",
    data_pagamento: "{data_pagamento}",
    forma_pagamento: formatBillingTypeText(tipo),
    descricao: desc,
    chave_pix: tipo === "PIX" ? pix : "",
    link_pagamento: link,
    quando_vence: venc ? "na data informada" : "{quando}",
    dias_atraso: "{dias}",
    encargos: "",
    extras: extras.join("\n"),
  });
  return;

  const dataFmt = venc
    ? new Date(`${venc}T12:00:00`).toLocaleDateString("pt-BR")
    : "{data}";
  const valorFmt =
    valor > 0 ? `R$ ${valor.toFixed(2).replace(".", ",")}` : "{valor}";

  let msg = `📋 *Nova Cobrança*\n\nOlá, ${nome}! 👋\n`;
  msg += `Você tem uma cobrança pendente:\n\n`;
  msg += `💰 *Valor:* ${valorFmt}\n`;
  msg += `📅 *Vencimento:* ${dataFmt}\n`;
  msg += `💳 *Forma de pagamento:* ${formatBillingTypeText(tipo)}\n`;
  msg += `📝 *Descrição:* ${desc}\n`;
  if (pix && tipo === "PIX") msg += `\n🔑 *Chave PIX:* ${pix}`;
  if (link) msg += `\n🔗 *Link para pagamento:* ${link}`;
  msg += `\n\n✅ Qualquer dúvida, estamos à disposição!`;

  preview.textContent = msg;
}

function atualizarPreviewRecorrenciaWpp() {
  const preview = document.getElementById("rcWppPreview");
  if (!preview || !document.getElementById("rcEnviarWpp")?.checked) return;

  const nome = document.getElementById("rcNome")?.value || "{nome}";
  const valor = parseCurrencyInput(document.getElementById("rcValor")?.value) || 0;
  const venc = document.getElementById("rcVencimento")?.value;
  const tipo = document.getElementById("rcBillingType")?.value || "PIX";
  const desc = document.getElementById("rcDescricao")?.value || "{descrição}";
  const pix = document.getElementById("rcChavePix")?.value;
  const link = document.getElementById("rcLinkPagamento")?.value;
  const cycle = document.getElementById("rcCycle")?.value || "MENSAL";
  const multa = Number(document.getElementById("rcMulta")?.value || 0);
  const juros = Number(document.getElementById("rcJuros")?.value || 0);

  const extras = [];
  if (multa > 0) extras.push(`⚠️ *Multa:* ${multa}%`);
  if (juros > 0) extras.push(`📈 *Juros:* ${juros}% ao mês`);
  if (cycle) extras.push(`🔁 *Ciclo:* ${formatCycle(cycle)}`);

  preview.textContent = buildChargePreviewMessage("criacao", {
    nome,
    primeiro_nome: String(nome || "{nome}").trim().split(/\s+/)[0] || "{nome}",
    valor: valor > 0 ? formatCurrency(valor) : "{valor}",
    valor_pago: valor > 0 ? formatCurrency(valor) : "{valor}",
    vencimento: venc
      ? new Date(`${venc}T12:00:00`).toLocaleDateString("pt-BR")
      : "{data}",
    data_pagamento: "{data_pagamento}",
    forma_pagamento: formatBillingTypeText(tipo),
    descricao: desc,
    chave_pix: tipo === "PIX" ? pix : "",
    link_pagamento: link,
    quando_vence: venc ? "na data informada" : "{quando}",
    dias_atraso: "{dias}",
    encargos: "",
    extras: extras.join("\n"),
  });
  return;

  const dataFmt = venc
    ? new Date(`${venc}T12:00:00`).toLocaleDateString("pt-BR")
    : "{data}";
  const valorFmt =
    valor > 0 ? `R$ ${valor.toFixed(2).replace(".", ",")}` : "{valor}";

  let msg = `📋 *Nova Cobrança*\n\nOlá, ${nome}! 👋\n`;
  msg += `Sua cobrança recorrente foi gerada:\n\n`;
  msg += `💰 *Valor:* ${valorFmt}\n`;
  msg += `📅 *Primeiro vencimento:* ${dataFmt}\n`;
  msg += `🔁 *Ciclo:* ${formatCycle(cycle)}\n`;
  msg += `💳 *Forma de pagamento:* ${formatBillingTypeText(tipo)}\n`;
  msg += `📝 *Descrição:* ${desc}\n`;
  if (pix && tipo === "PIX") msg += `\n🔑 *Chave PIX:* ${pix}`;
  if (link) msg += `\n🔗 *Link para pagamento:* ${link}`;
  msg += `\n\n✅ Qualquer dúvida, estamos à disposição!`;

  preview.textContent = msg;
}

function renderPaginacao() {
  const wrap = document.getElementById("paginacao");
  if (!wrap) return;

  if (State.pages <= 1) {
    wrap.innerHTML = "";
    return;
  }

  wrap.innerHTML = `
    <button class="btn-page" onclick="goPage(${State.page - 1})" ${State.page <= 1 ? "disabled" : ""}>
      « Anterior
    </button>
    <span style="color:var(--muted);font-size:13px">Página ${State.page} de ${State.pages}</span>
    <button class="btn-page" onclick="goPage(${State.page + 1})" ${State.page >= State.pages ? "disabled" : ""}>
      Próxima »
    </button>
  `;
}

function goPage(page) {
  if (page < 1 || page > State.pages) return;
  State.page = page;
  loadCobrancas();
}

function abrirModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add("open");
    updateBodyOverflow();
  }
}

function fecharModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove("open");
    updateBodyOverflow();
  }
}

function updateBodyOverflow() {
  const hasOpenModal = document.querySelector(".modal-overlay-cob.open");
  document.body.style.overflow = hasOpenModal ? "hidden" : "";
}

function toggleWppSection() {
  const checked = document.getElementById("cbEnviarWpp").checked;
  const sec = document.getElementById("wppSection");
  sec.style.display = checked ? "block" : "none";
  if (checked) atualizarPreviewWpp();
}

function toggleRecorrenciaSection() {
  const checked = document.getElementById("cbRecorrente").checked;
  const sec = document.getElementById("recorrenciaSection");
  sec.style.display = checked ? "block" : "none";
}

function toggleRecorrenciaWppSection() {
  const checked = document.getElementById("rcEnviarWpp").checked;
  const sec = document.getElementById("rcWppSection");
  sec.style.display = checked ? "block" : "none";
  if (checked) atualizarPreviewRecorrenciaWpp();
}

function toggleSection(el) {
  el.classList.toggle("open");
  const content = el.nextElementSibling;
  content?.classList.toggle("open");
}

function bindCurrencyMask(ids) {
  ids.forEach((id) => {
    const input = document.getElementById(id);
    if (!input || input.dataset.currencyMaskBound === "1") return;

    input.dataset.currencyMaskBound = "1";
    input.addEventListener("input", () => applyCurrencyMask(input));
    input.addEventListener("blur", () => applyCurrencyMask(input));
  });
}

function applyCurrencyMask(input) {
  const digits = String(input?.value || "").replace(/\D/g, "");
  input.value = digits ? formatCurrencyMaskDigits(digits) : "";
}

function formatCurrencyMaskDigits(digits) {
  const numericValue = Number(digits) / 100;
  return numericValue.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseCurrencyInput(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[R$]/g, "")
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bindPhoneMask(ids) {
  ids.forEach((id) => {
    const input = document.getElementById(id);
    if (!input || input.dataset.phoneMaskBound === "1") return;

    input.dataset.phoneMaskBound = "1";
    input.addEventListener("focus", () => {
      if (!String(input.value || "").trim()) {
        input.value = PHONE_BR_PREFIX;
      }
      applyPhoneMask(input);
    });
    input.addEventListener("input", () => applyPhoneMask(input));
    input.addEventListener("blur", () => applyPhoneMask(input));
    applyPhoneMask(input);
  });
}

function setPhoneInputValue(id, value = "") {
  const input = document.getElementById(id);
  if (!input) return;
  input.value = value;
  applyPhoneMask(input);
}

function applyPhoneMask(input) {
  const digits = normalizeBrazilPhoneDigits(input?.value);
  input.value = formatBrazilPhone(digits);
}

function normalizeBrazilPhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return PHONE_BR_PREFIX;
  if (PHONE_BR_PREFIX.startsWith(digits) && digits.length <= PHONE_BR_PREFIX.length) {
    return PHONE_BR_PREFIX;
  }

  const raw = digits.startsWith(PHONE_BR_PREFIX) ? digits : `${PHONE_BR_PREFIX}${digits}`;
  return raw.slice(0, PHONE_BR_MAX_LENGTH);
}

function formatBrazilPhone(digits) {
  const normalized = normalizeBrazilPhoneDigits(digits);
  const ddiLength = PHONE_BR_PREFIX.length;
  const countryCode = normalized.slice(0, ddiLength);
  const ddd = normalized.slice(ddiLength, ddiLength + 2);
  const phone = normalized.slice(ddiLength + 2);

  let formatted = countryCode;
  if (ddd) {
    formatted += ` (${ddd}`;
    if (ddd.length === 2) formatted += ")";
  }
  if (phone) {
    formatted += ` ${formatBrazilPhoneLocal(phone)}`;
  }
  return formatted;
}

function formatBrazilPhoneLocal(phone) {
  if (phone.length <= 4) return phone;
  if (phone.length <= 8) {
    return `${phone.slice(0, 4)}-${phone.slice(4)}`;
  }
  return `${phone.slice(0, 5)}-${phone.slice(5, 9)}`;
}

function isValidBrazilPhone(value) {
  const digits = normalizeBrazilPhoneDigits(value);
  return digits.startsWith(PHONE_BR_PREFIX) && digits.length >= PHONE_BR_MIN_LENGTH;
}

function formatPhoneDisplay(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "—";
  if (digits.length > PHONE_BR_MAX_LENGTH && !digits.startsWith(PHONE_BR_PREFIX)) {
    return digits;
  }
  return formatBrazilPhone(digits);
}

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-overlay-cob")) {
    e.target.classList.remove("open");
    updateBodyOverflow();
  }
});

function syncBillingTypeSections() {
  const cbType = document.getElementById("cbBillingType")?.value;
  const rcType = document.getElementById("rcBillingType")?.value;

  const secPix = document.getElementById("secaoPix");
  const secPixRecorrencia = document.getElementById("secaoPixRecorrencia");

  if (secPix) secPix.style.display = cbType === "PIX" ? "block" : "none";
  if (secPixRecorrencia) {
    secPixRecorrencia.style.display = rcType === "PIX" ? "block" : "none";
  }
}

function formatCurrency(value) {
  return `R$ ${Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = String(dateStr).split("-");
  if (!y || !m || !d) return "—";
  return `${d}/${m}/${y}`;
}

function formatBillingType(type) {
  const map = {
    PIX: "⚡ PIX",
    BOLETO: "📄 Boleto",
    CARTAO: "💳 Cartão",
    TRANSFERENCIA: "🏦 Transferência",
    DINHEIRO: "💵 Dinheiro",
    OUTRO: "📌 Outro",
  };
  return map[type] || type;
}

function formatBillingTypeText(type) {
  const map = {
    PIX: "PIX",
    BOLETO: "Boleto / Depósito",
    CARTAO: "Cartão",
    TRANSFERENCIA: "Transferência",
    DINHEIRO: "Dinheiro",
    OUTRO: "Outro",
  };
  return map[type] || type;
}

function formatStatus(status) {
  const map = {
    PENDENTE: "⏳ Pendente",
    PAGO: "✅ Pago",
    VENCIDO: "🔴 Vencido",
    CANCELADO: "❌ Cancelado",
    PARCIAL: "🔵 Parcial",
  };
  return map[status] || status;
}

function formatCycle(cycle) {
  const map = {
    SEMANAL: "Semanal",
    QUINZENAL: "Quinzenal",
    MENSAL: "Mensal",
    TRIMESTRAL: "Trimestral",
    SEMESTRAL: "Semestral",
    ANUAL: "Anual",
  };
  return map[cycle] || cycle;
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const temp = document.createElement("textarea");
      temp.value = text;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand("copy");
      temp.remove();
    }
    showToast("success", "Copiado!");
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao copiar");
  }
}

function maskCpfCnpj(input) {
  let v = input.value.replace(/\D/g, "");
  if (v.length <= 11) {
    v = v.replace(/(\d{3})(\d)/, "$1.$2");
    v = v.replace(/(\d{3})(\d)/, "$1.$2");
    v = v.replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  } else {
    v = v.replace(/^(\d{2})(\d)/, "$1.$2");
    v = v.replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3");
    v = v.replace(/\.(\d{3})(\d)/, ".$1/$2");
    v = v.replace(/(\d{4})(\d)/, "$1-$2");
  }
  input.value = v;
}

function setDefaultVencimento(targetId = "cbVencimento") {
  const input = document.getElementById(targetId);
  if (!input) return;
  const date = new Date();
  date.setDate(date.getDate() + 7);
  input.value = formatDateInputLocal(date);
}

function debounceSearch() {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    State.page = 1;
    loadCobrancas();
  }, 300);
}

function debounceClientes() {
  clearTimeout(searchClienteDebounce);
  searchClienteDebounce = setTimeout(() => loadClientes(), 300);
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escAttr(str) {
  return escHtml(str).replace(/`/g, "&#096;");
}

function quoteJs(value) {
  return JSON.stringify(String(value || ""));
}

const DEFAULT_CHARGE_TEMPLATES = {
  criacao: [
    "📋 *Nova Cobrança*",
    "",
    "Olá, {{primeiro_nome}}! 👋",
    "Você tem uma cobrança pendente:",
    "",
    "💰 *Valor:* {{valor}}",
    "📅 *Vencimento:* {{vencimento}}",
    "💳 *Forma de pagamento:* {{forma_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "{{#chave_pix}}",
    "🔑 *Chave PIX:* {{chave_pix}}",
    "{{/chave_pix}}",
    "{{#link_pagamento}}",
    "🔗 *Link para pagamento:* {{link_pagamento}}",
    "{{/link_pagamento}}",
    "{{#extras}}",
    "{{extras}}",
    "{{/extras}}",
    "",
    "Qualquer dúvida, estamos à disposição! ✅",
  ].join("\n"),
  lembrete_vencimento: [
    "⏰ *Lembrete de Vencimento*",
    "",
    "Olá, {{primeiro_nome}}! Sua cobrança vence {{quando_vence}}:",
    "",
    "💰 *Valor:* {{valor}}",
    "📅 *Vencimento:* {{vencimento}}",
    "💳 *Forma de pagamento:* {{forma_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "{{#chave_pix}}",
    "🔑 *Chave PIX:* {{chave_pix}}",
    "{{/chave_pix}}",
    "{{#link_pagamento}}",
    "🔗 *Link para pagamento:* {{link_pagamento}}",
    "{{/link_pagamento}}",
    "{{#extras}}",
    "{{extras}}",
    "{{/extras}}",
    "",
    "Se precisar de qualquer apoio, estamos por aqui. ✅",
  ].join("\n"),
  atraso: [
    "🔴 *Cobrança em Atraso*",
    "",
    "Olá, {{primeiro_nome}}! Identificamos uma cobrança em aberto:",
    "",
    "💰 *Valor:* {{valor}}",
    "📅 *Vencimento:* {{vencimento}} ({{dias_atraso}} dia(s) em atraso)",
    "💳 *Forma de pagamento:* {{forma_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "{{#encargos}}",
    "⚠️ *Encargos:* {{encargos}}",
    "{{/encargos}}",
    "{{#chave_pix}}",
    "🔑 *Chave PIX:* {{chave_pix}}",
    "{{/chave_pix}}",
    "{{#link_pagamento}}",
    "🔗 *Link para pagamento:* {{link_pagamento}}",
    "{{/link_pagamento}}",
    "{{#extras}}",
    "{{extras}}",
    "{{/extras}}",
    "",
    "Se já realizou o pagamento, por favor nos avise. 🙏",
  ].join("\n"),
  confirmacao_pagamento: [
    "✅ *Pagamento Confirmado*",
    "",
    "Olá, {{primeiro_nome}}! Recebemos a confirmação do seu pagamento:",
    "",
    "💰 *Valor pago:* {{valor_pago}}",
    "📅 *Data:* {{data_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "",
    "Muito obrigado! 🙏",
  ].join("\n"),
  cancelamento: [
    "⚪ *Cobrança Cancelada*",
    "",
    "Olá, {{primeiro_nome}}. Esta cobrança foi cancelada:",
    "",
    "📝 *Descrição:* {{descricao}}",
    "📅 *Vencimento original:* {{vencimento}}",
    "",
    "Desconsidere esta cobrança. ✅",
  ].join("\n"),
};

function loadCobrancaAccountDefaults() {
  const fallback = {
    defaultSessionName: "",
    billingDefaults: {
      billing_type: "PIX",
      descricao: "",
      chave_pix: "",
      link_pagamento: "",
      multa_percentual: 0,
      juros_percentual: 0,
      desconto_percentual: 0,
      desconto_limite_dias: 0,
    },
    messageTemplates: {
      criacao: "",
      lembrete_vencimento: "",
      atraso: "",
      confirmacao_pagamento: "",
      cancelamento: "",
    },
  };

  const element = document.getElementById("cobrancaAccountDefaults");
  if (!element?.textContent) return fallback;

  try {
    const parsed = JSON.parse(element.textContent);
    return {
      defaultSessionName: String(parsed?.defaultSessionName || ""),
      billingDefaults: {
        ...fallback.billingDefaults,
        ...(parsed?.billingDefaults || {}),
      },
      messageTemplates: {
        ...fallback.messageTemplates,
        ...(parsed?.messageTemplates || {}),
      },
    };
  } catch (err) {
    console.warn("Falha ao ler defaults da conta para cobranças:", err);
    return fallback;
  }
}

function getBillingDefaults() {
  return ACCOUNT_DEFAULTS?.billingDefaults || {};
}

function getConfiguredChargeTemplate(type) {
  const custom = String(ACCOUNT_DEFAULTS?.messageTemplates?.[type] || "").trim();
  return custom || DEFAULT_CHARGE_TEMPLATES[type];
}

function normalizeTemplateValue(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function renderChargeTemplateMessage(template, replacements) {
  let rendered = String(template || "");

  rendered = rendered.replace(
    /{{#([a-zA-Z0-9_]+)}}([\s\S]*?){{\/\1}}/g,
    (_, key, content) => {
      const value = normalizeTemplateValue(replacements[key]).trim();
      return value ? content : "";
    }
  );

  rendered = rendered.replace(/{{([a-zA-Z0-9_]+)}}/g, (_, key) =>
    normalizeTemplateValue(replacements[key])
  );

  return rendered
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildChargePreviewMessage(type, payload) {
  const template = getConfiguredChargeTemplate(type);
  return renderChargeTemplateMessage(template, payload);
}

function applyBillingDefaults(prefix) {
  const defaults = getBillingDefaults();
  const typeInput = document.getElementById(`${prefix}BillingType`);
  const descricaoInput = document.getElementById(`${prefix}Descricao`);
  const pixInput = document.getElementById(`${prefix}ChavePix`);
  const linkInput = document.getElementById(`${prefix}LinkPagamento`);
  const multaInput = document.getElementById(`${prefix}Multa`);
  const jurosInput = document.getElementById(`${prefix}Juros`);
  const descontoInput = document.getElementById(`${prefix}Desconto`);
  const descontoDiasInput = document.getElementById(`${prefix}DescontoDias`);

  if (typeInput) typeInput.value = defaults.billing_type || "PIX";
  if (descricaoInput) descricaoInput.value = defaults.descricao || "";
  if (pixInput) pixInput.value = defaults.chave_pix || "";
  if (linkInput) linkInput.value = defaults.link_pagamento || "";
  if (multaInput) multaInput.value = Number(defaults.multa_percentual || 0) || "";
  if (jurosInput) jurosInput.value = Number(defaults.juros_percentual || 0) || "";
  if (descontoInput) descontoInput.value = Number(defaults.desconto_percentual || 0) || "";
  if (descontoDiasInput) {
    descontoDiasInput.value = Number(defaults.desconto_limite_dias || 0) || "";
  }
}

function setSessionSelectValue(id, preferredValue = "") {
  const select = document.getElementById(id);
  if (!select) return;

  const desired = String(preferredValue || "").trim();
  if (!desired) {
    if (select.options.length) {
      select.selectedIndex = 0;
    }
    return;
  }

  const match = Array.from(select.options).find((option) => option.value === desired);
  if (match) {
    select.value = desired;
    return;
  }

  if (select.options.length) {
    select.selectedIndex = 0;
  }
}

const PHONE_BR_PREFIX = getConfiguredDefaultDdi();
const PHONE_BR_MIN_LENGTH = PHONE_BR_PREFIX.length + 10;
const PHONE_BR_MAX_LENGTH = PHONE_BR_PREFIX.length + 11;

function getConfiguredDefaultDdi() {
  const digits = String(document.body?.dataset?.defaultDdi || "55")
    .replace(/\D/g, "")
    .slice(0, 4);

  return digits || "55";
}

function formatDateInputLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
