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
  selectedChargeIds: [],
  bulkActionLoading: "",
  whatsappPreviewCharge: null,
  whatsappPreviewType: "",
  whatsappPreviewRequestId: 0,
  reopenDetalhesAfterPagamento: false,
  currentClienteDashboardId: null,
  currentClienteDashboard: null,
  exportCsvLoading: false,
  mpSettings: null,
  currentMpCheckoutChargeId: null,
};

const ACCOUNT_DEFAULTS = loadCobrancaAccountDefaults();

let socket = null;
let searchDebounce = null;
let searchClienteDebounce = null;
let realtimeRefreshTimer = null;
const CHARGE_DAY_MS = 24 * 60 * 60 * 1000;

window.onload = async () => {
  setDefaultVencimento();
  initSocket();
  syncBillingTypeSections();

  await Promise.allSettled([
    loadSummary(),
    loadFinancialHealth(),
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
      loadFinancialHealth(),
      loadCobrancas(),
      loadRecorrencias(),
      loadClientes(),
    ])
      .then(() => Promise.all([
        refreshOpenClienteDashboard(),
        refreshOpenMpCheckoutModal(),
      ]))
      .catch((err) => console.warn("Falha no refresh em tempo real:", err));
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

async function loadFinancialHealth() {
  const wrap = document.getElementById("financialHealthPanel");
  if (!wrap) return;

  try {
    const res = await fetch("/api/cobrancas/health");
    const data = await res.json();
    if (!data.ok) return;
    renderFinancialHealth(data.health);
  } catch (err) {
    console.warn("Erro ao carregar saúde financeira:", err);
  }
}

function renderFinancialHealth(health) {
  const wrap = document.getElementById("financialHealthPanel");
  if (!wrap) return;

  const config = getHealthVisualConfig(health?.health_level);
  const inadimplencia = Number(health?.inadimplencia_percentual || 0);
  const aging = Array.isArray(health?.aging) ? health.aging : [];
  const alertas = Array.isArray(health?.alertas) ? health.alertas : [];

  const agingHtml = aging.length
    ? aging
        .map(
          (bucket) => `
            <div class="health-aging-item">
              <div>
                <strong>${escHtml(bucket.faixa)}</strong>
                <span>${Number(bucket.qtd || 0)} cobrança(s)</span>
              </div>
              <strong>${formatCurrency(bucket.valor)}</strong>
            </div>
          `
        )
        .join("")
    : `<div class="health-empty">Nenhuma cobrança vencida no momento.</div>`;

  const alertasHtml = alertas.length
    ? alertas
        .map(
          (alerta) => `
            <div class="health-alert-item">
              <div class="health-alert-main">
                <strong>${escHtml(alerta.cliente_nome)}</strong>
                <span>${escHtml(formatPhoneDisplay(alerta.cliente_telefone))}</span>
              </div>
              <div class="health-alert-meta">
                <strong>${formatCurrency(alerta.total_vencido)}</strong>
                <span>Mais antigo em ${formatDate(alerta.vencimento_mais_antigo)} • ${Number(alerta.dias_em_atraso || 0)} dia(s)</span>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="health-empty">Nenhum alerta crítico acima de R$ 500,00.</div>`;

  wrap.innerHTML = `
    <div class="financial-health-card ${config.cardClass}">
      <div class="financial-health-head">
        <div>
          <div class="financial-health-kicker">Saúde financeira</div>
          <h3>${config.title}</h3>
          <p>${formatCurrency(health?.valor_vencido_total)} em aberto • ${formatPercent(inadimplencia)} do MRR recorrente</p>
        </div>
        <span class="health-status-pill ${config.pillClass}">
          <i class="fa-solid ${config.icon}"></i>
          ${config.label}
        </span>
      </div>

      <div class="health-metrics">
        <div class="health-metric">
          <span>MRR ativo</span>
          <strong>${formatCurrency(health?.mrr)}</strong>
          <small>${Number(health?.recorrencias_ativas || 0)} recorrência(s) ativa(s)</small>
        </div>
        <div class="health-metric">
          <span>Inadimplência</span>
          <strong>${formatCurrency(health?.valor_vencido_total)}</strong>
          <small>${Number(health?.total_clientes_inadimplentes || 0)} cliente(s) em atraso</small>
        </div>
        <div class="health-metric">
          <span>Churn do mês</span>
          <strong>${formatCurrency(health?.churn?.valor)}</strong>
          <small>${Number(health?.churn?.total || 0)} cancelamento(s)</small>
        </div>
        <div class="health-metric">
          <span>Vencidas</span>
          <strong>${Number(health?.total_cobrancas_vencidas || 0).toLocaleString("pt-BR")}</strong>
          <small>${config.alertText}</small>
        </div>
      </div>

      <div class="health-grid">
        <section class="health-section">
          <div class="health-section-title">
            <i class="fa-solid fa-chart-line"></i>
            Aging do atraso
          </div>
          <div class="health-aging-list">${agingHtml}</div>
        </section>

        <section class="health-section">
          <div class="health-section-title">
            <i class="fa-solid fa-bell"></i>
            Alertas proativos
          </div>
          <div class="health-alert-list">${alertasHtml}</div>
        </section>
      </div>
    </div>
  `;
}

function getHealthVisualConfig(level) {
  const map = {
    green: {
      title: "Operação saudável",
      label: "Saudável",
      icon: "fa-circle-check",
      cardClass: "health-green-card",
      pillClass: "health-green",
      alertText: "Sem pressão relevante",
    },
    yellow: {
      title: "Atenção à inadimplência",
      label: "Atenção",
      icon: "fa-triangle-exclamation",
      cardClass: "health-yellow-card",
      pillClass: "health-yellow",
      alertText: "Janela boa para cobrança",
    },
    red: {
      title: "Ação imediata recomendada",
      label: "Crítico",
      icon: "fa-circle-exclamation",
      cardClass: "health-red-card",
      pillClass: "health-red",
      alertText: "Clientes exigem ação rápida",
    },
  };

  return map[level] || map.green;
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function formatSignedPercent(value) {
  const numeric = Number(value || 0);
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${formatPercent(numeric)}`;
}

function getSummaryRevenueTrendMeta(summary) {
  const direction = String(summary?.variacao_recebimento_direcao || "flat");
  const currentValue = Number(summary?.valor_pago_mes || 0);
  const previousValue = Number(summary?.valor_pago_mes_anterior || 0);
  const deltaValue = Number(summary?.variacao_recebimento_valor || 0);
  const deltaPercent =
    summary?.variacao_recebimento_percentual == null
      ? null
      : Number(summary.variacao_recebimento_percentual);

  if (direction === "up") {
    return {
      badgeClass: "is-up",
      icon: "fa-arrow-trend-up",
      badge: deltaPercent == null ? "Alta" : formatSignedPercent(deltaPercent),
      copy: `${formatCurrency(Math.abs(deltaValue))} acima do mês anterior`,
    };
  }

  if (direction === "down") {
    return {
      badgeClass: "is-down",
      icon: "fa-arrow-trend-down",
      badge: deltaPercent == null ? "Queda" : formatSignedPercent(deltaPercent),
      copy: `${formatCurrency(Math.abs(deltaValue))} abaixo do mês anterior`,
    };
  }

  if (direction === "new") {
    return {
      badgeClass: "is-new",
      icon: "fa-bolt",
      badge: "Novo",
      copy:
        previousValue > 0
          ? `Base anterior: ${formatCurrency(previousValue)}`
          : `Primeiro mês com ${formatCurrency(currentValue)} recebido`,
    };
  }

  return {
    badgeClass: "is-flat",
    icon: "fa-wave-square",
    badge: "Estável",
    copy:
      previousValue > 0
        ? `${formatCurrency(previousValue)} no mês anterior`
        : "Sem variação relevante no comparativo",
  };
}

function buildSummarySparkline(points) {
  const series = Array.isArray(points) ? points : [];
  if (!series.length) {
    return { svg: "", startLabel: "", endLabel: "" };
  }

  const width = 168;
  const height = 40;
  const values = series.map((point) => Number(point?.valor || 0));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const spread = Math.max(max - min, 1);
  const stepX = series.length > 1 ? width / (series.length - 1) : width;

  const coords = values.map((value, index) => {
    const x = Number((stepX * index).toFixed(2));
    const normalized = (value - min) / spread;
    const y = Number((height - normalized * (height - 6) - 3).toFixed(2));
    return { x, y };
  });

  const linePath = coords
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${height} L 0 ${height} Z`;
  const lastPoint = coords[coords.length - 1];

  return {
    svg: `
      <svg viewBox="0 0 ${width} ${height}" class="summary-sparkline" aria-hidden="true" preserveAspectRatio="none">
        <defs>
          <linearGradient id="summarySparklineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(46, 230, 166, 0.28)"></stop>
            <stop offset="100%" stop-color="rgba(46, 230, 166, 0)"></stop>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#summarySparklineFill)"></path>
        <path d="${linePath}" fill="none" stroke="rgba(46, 230, 166, 0.92)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
        <circle cx="${lastPoint.x}" cy="${lastPoint.y}" r="3.5" fill="#2ee6a6" stroke="rgba(15, 21, 48, 0.95)" stroke-width="1.5"></circle>
      </svg>
    `,
    startLabel: String(series[0]?.label || ""),
    endLabel: String(series[series.length - 1]?.label || ""),
  };
}

function renderSummaryCards(s) {
  const wrap = document.getElementById("summaryCards");
  if (!wrap) return;
  const trend = getSummaryRevenueTrendMeta(s);
  const sparkline = buildSummarySparkline(s?.recebimentos_ultimos_6_meses);

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
        <div class="summary-card-trend-row">
          <span class="summary-trend-badge ${trend.badgeClass}">
            <i class="fa-solid ${trend.icon}"></i>
            ${escHtml(trend.badge)}
          </span>
          <span class="summary-card-trend-copy">${escHtml(trend.copy)}</span>
        </div>
        <div class="summary-sparkline-wrap">
          ${sparkline.svg}
          <div class="summary-sparkline-labels">
            <span>${escHtml(sparkline.startLabel)}</span>
            <span>${escHtml(sparkline.endLabel)}</span>
          </div>
        </div>
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

function handleStatusFilterChange() {
  reloadCobrancasFromFilters();
}

function handleDateFilterChange() {
  reloadCobrancasFromFilters();
}

function reloadCobrancasFromFilters() {
  State.page = 1;
  syncActiveCobrancaShortcut();
  loadCobrancas();
}

function getActiveCobrancaFilters() {
  return {
    status: document.getElementById("filtroStatus")?.value || "all",
    search: document.getElementById("filtroBusca")?.value.trim() || "",
    from: document.getElementById("filtroFrom")?.value || "",
    to: document.getElementById("filtroTo")?.value || "",
  };
}

function buildCobrancasQueryParams(extraParams = {}) {
  const params = new URLSearchParams();
  const entries = {
    ...getActiveCobrancaFilters(),
    ...extraParams,
  };

  Object.entries(entries).forEach(([key, value]) => {
    if (value == null) return;
    const text = String(value);
    if (!text && key !== "search" && key !== "from" && key !== "to") return;
    params.set(key, text);
  });

  return params;
}

function parseDownloadFilename(contentDisposition) {
  const header = String(contentDisposition || "");
  if (!header) return "";

  const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch && encodedMatch[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch (error) {
      console.warn("Não foi possível decodificar o nome do arquivo exportado.", error);
    }
  }

  const plainMatch = header.match(/filename="?([^";]+)"?/i);
  return plainMatch && plainMatch[1] ? plainMatch[1] : "";
}

async function exportarCobrancasCsv() {
  if (State.exportCsvLoading) return;

  const button = document.getElementById("btnExportarCsv");
  State.exportCsvLoading = true;

  if (button) {
    button.disabled = true;
    if (typeof setButtonLoading === "function") {
      setButtonLoading(button, true, "Exportando...");
    }
  }

  try {
    const qs = buildCobrancasQueryParams();
    const response = await fetch(`/api/cobrancas/exportar?${qs.toString()}`);
    const contentType = String(response.headers.get("content-type") || "");

    if (!response.ok) {
      let message = "Erro ao exportar cobranças";

      if (contentType.includes("application/json")) {
        const data = await response.json();
        message = data?.error || message;
      } else {
        const text = await response.text();
        if (text) message = text;
      }

      throw new Error(message);
    }

    const blob = await response.blob();
    const filename =
      parseDownloadFilename(response.headers.get("content-disposition")) ||
      `cobrancas-${formatDateInputLocal(new Date())}.csv`;
    const blobUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(blobUrl);

    showToast("success", "CSV exportado com sucesso!");
  } catch (error) {
    console.error(error);
    showToast("error", error?.message || "Erro de conexão ao exportar cobranças");
  } finally {
    State.exportCsvLoading = false;

    if (button) {
      if (typeof setButtonLoading === "function") {
        setButtonLoading(button, false);
      }
      button.disabled = false;
    }
  }
}

function applyCobrancaDateShortcut(shortcut) {
  const preset = getCobrancaShortcutPreset(shortcut);
  if (!preset) return;

  const statusInput = document.getElementById("filtroStatus");
  const fromInput = document.getElementById("filtroFrom");
  const toInput = document.getElementById("filtroTo");

  if (statusInput) statusInput.value = preset.status;
  if (fromInput) fromInput.value = preset.from;
  if (toInput) toInput.value = preset.to;

  reloadCobrancasFromFilters();
}

function syncActiveCobrancaShortcut() {
  const activeShortcut = detectCobrancaShortcut();

  document.querySelectorAll(".filter-shortcut-btn[data-shortcut]").forEach((button) => {
    const isActive = button.dataset.shortcut === activeShortcut;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function detectCobrancaShortcut() {
  const status = document.getElementById("filtroStatus")?.value || "all";
  const from = document.getElementById("filtroFrom")?.value || "";
  const to = document.getElementById("filtroTo")?.value || "";
  const currentDate = new Date();
  const todayValue = formatDateInputLocal(currentDate);
  const currentWeek = getCobrancaDateRange("week", currentDate);
  const currentMonth = getCobrancaDateRange("month", currentDate);

  if (status === "VENCIDO" && !from && !to) return "overdue";
  if (status === "all" && from === todayValue && to === todayValue) return "today";
  if (status === "all" && from === currentWeek.from && to === currentWeek.to) return "week";
  if (status === "all" && from === currentMonth.from && to === currentMonth.to) return "month";

  return "";
}

function getCobrancaShortcutPreset(shortcut) {
  switch (shortcut) {
    case "today":
      return {
        status: "all",
        ...getCobrancaDateRange("today"),
      };
    case "week":
      return {
        status: "all",
        ...getCobrancaDateRange("week"),
      };
    case "month":
      return {
        status: "all",
        ...getCobrancaDateRange("month"),
      };
    case "overdue":
      return {
        status: "VENCIDO",
        from: "",
        to: "",
      };
    default:
      return null;
  }
}

function getCobrancaDateRange(type, baseDate = new Date()) {
  const anchor = new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate()
  );

  if (type === "today") {
    const value = formatDateInputLocal(anchor);
    return { from: value, to: value };
  }

  if (type === "week") {
    const fromDate = getStartOfWeekLocal(anchor);
    const toDate = new Date(fromDate);
    toDate.setDate(toDate.getDate() + 6);
    return {
      from: formatDateInputLocal(fromDate),
      to: formatDateInputLocal(toDate),
    };
  }

  if (type === "month") {
    const fromDate = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const toDate = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return {
      from: formatDateInputLocal(fromDate),
      to: formatDateInputLocal(toDate),
    };
  }

  return { from: "", to: "" };
}

function getStartOfWeekLocal(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOfWeek = start.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  start.setDate(start.getDate() + diffToMonday);
  return start;
}

function parseDateOnlyLocal(dateStr) {
  const [year, month, day] = String(dateStr || "")
    .split("-")
    .map((part) => Number(part));

  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function getTodayReferenceLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
}

function getChargeUrgencyMeta(charge) {
  if (!charge?.vencimento) return null;
  if (charge.status === "PAGO" || charge.status === "CANCELADO") return null;

  const dueDate = parseDateOnlyLocal(charge.vencimento);
  if (!dueDate) return null;

  const diffDays = Math.round((getTodayReferenceLocal().getTime() - dueDate.getTime()) / CHARGE_DAY_MS);

  if (charge.status === "VENCIDO" || diffDays > 0) {
    const daysOverdue = Math.max(1, diffDays);

    if (daysOverdue >= 30) {
      return {
        rowClass: "row-urgency-critical",
        chipClass: "urgency-chip-critical",
        label: `${daysOverdue} dias em atraso`,
        title: `Cobrança vencida há ${daysOverdue} dias`,
      };
    }

    if (daysOverdue >= 8) {
      return {
        rowClass: "row-urgency-danger",
        chipClass: "urgency-chip-danger",
        label: `${daysOverdue} dias em atraso`,
        title: `Cobrança vencida há ${daysOverdue} dias`,
      };
    }

    return {
      rowClass: "row-urgency-warning",
      chipClass: "urgency-chip-warning",
      label: `${daysOverdue} ${daysOverdue === 1 ? "dia" : "dias"} em atraso`,
      title: `Cobrança vencida há ${daysOverdue} ${daysOverdue === 1 ? "dia" : "dias"}`,
    };
  }

  if (diffDays === 0) {
    return {
      rowClass: "row-urgency-today",
      chipClass: "urgency-chip-today",
      label: "Vence hoje",
      title: "Cobrança com vencimento hoje",
    };
  }

  return null;
}

function getSelectedChargeIds() {
  const ids = Array.isArray(State.selectedChargeIds) ? State.selectedChargeIds : [];
  return Array.from(
    new Set(
      ids
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
}

function getCurrentPageChargeIds() {
  return (Array.isArray(State.cobrancas) ? State.cobrancas : [])
    .map((item) => Number(item.id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function getSelectedCharges() {
  const selectedIds = new Set(getSelectedChargeIds());
  return (Array.isArray(State.cobrancas) ? State.cobrancas : []).filter((item) =>
    selectedIds.has(Number(item.id))
  );
}

function pruneSelectedChargeIds() {
  const currentIds = new Set(getCurrentPageChargeIds());
  State.selectedChargeIds = getSelectedChargeIds().filter((id) => currentIds.has(id));
}

function isChargeEligibleForBulkAction(charge, action) {
  if (!charge) return false;

  switch (action) {
    case "pay":
    case "notify":
    case "cancel":
      return charge.status === "PENDENTE" || charge.status === "VENCIDO";
    default:
      return false;
  }
}

function getBulkSelectionStats() {
  const selected = getSelectedCharges();
  const payEligible = selected.filter((charge) => isChargeEligibleForBulkAction(charge, "pay"));
  const notifyEligible = selected.filter((charge) => isChargeEligibleForBulkAction(charge, "notify"));
  const cancelEligible = selected.filter((charge) => isChargeEligibleForBulkAction(charge, "cancel"));

  return {
    selected,
    total: selected.length,
    payEligible,
    notifyEligible,
    cancelEligible,
    ignoredCount: selected.length - payEligible.length,
  };
}

function syncSelectedChargeRows() {
  const selectedIds = new Set(getSelectedChargeIds());

  document.querySelectorAll("#cobrancasTableBody tr").forEach((row) => {
    const checkbox = row.querySelector(".cobranca-row-checkbox");
    if (!(checkbox instanceof HTMLInputElement)) return;

    const rowId = Number(checkbox.value);
    const isSelected = selectedIds.has(rowId);
    checkbox.checked = isSelected;
    row.classList.toggle("is-selected", isSelected);
  });
}

function syncSelectedChargesUi() {
  syncSelectedChargeRows();
  syncSelectAllCobrancasCheckbox();
  renderBulkActionsBar();
}

function syncSelectAllCobrancasCheckbox() {
  const checkbox = document.getElementById("selectAllCobrancas");
  if (!checkbox) return;

  const pageIds = getCurrentPageChargeIds();
  const selectedIds = new Set(getSelectedChargeIds());
  const selectedCount = pageIds.filter((id) => selectedIds.has(id)).length;

  checkbox.checked = pageIds.length > 0 && selectedCount === pageIds.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < pageIds.length;
  checkbox.disabled = !pageIds.length || Boolean(State.bulkActionLoading);
}

function toggleCobrancaSelection(id, checked) {
  if (State.bulkActionLoading) return;

  const selectedIds = new Set(getSelectedChargeIds());
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) return;

  if (checked) {
    selectedIds.add(numericId);
  } else {
    selectedIds.delete(numericId);
  }

  State.selectedChargeIds = Array.from(selectedIds);
  syncSelectedChargesUi();
}

function toggleSelectAllCobrancas(checked) {
  if (State.bulkActionLoading) return;
  State.selectedChargeIds = checked ? getCurrentPageChargeIds() : [];
  syncSelectedChargesUi();
}

function clearSelectedCobrancas() {
  State.selectedChargeIds = [];
  syncSelectedChargesUi();
}

function setBulkActionButtonState(buttonId, actionKey, iconClass, defaultLabel, count, loadingLabel) {
  const button = document.getElementById(buttonId);
  if (!button) return;

  const isLoading = State.bulkActionLoading === actionKey;
  const isAnyLoading = Boolean(State.bulkActionLoading);

  button.disabled = isLoading ? true : isAnyLoading || count <= 0;
  button.innerHTML = isLoading
    ? `<i class="${iconClass}"></i> ${loadingLabel}`
    : `<i class="${iconClass}"></i> ${defaultLabel}${count > 0 ? ` (${count})` : ""}`;
}

function renderBulkActionsBar() {
  const bar = document.getElementById("bulkActionsBar");
  const count = document.getElementById("bulkActionsCount");
  const hint = document.getElementById("bulkActionsHint");
  const clearButton = document.getElementById("btnBulkClear");
  if (!bar || !count || !hint || !clearButton) return;

  const stats = getBulkSelectionStats();
  const total = stats.total;

  bar.hidden = total === 0;
  if (bar.hidden) {
    count.textContent = "0 selecionadas";
    hint.textContent = "Selecione cobranças da tabela para usar ações em lote.";
    setBulkActionButtonState(
      "btnBulkPay",
      "pay",
      "fa-solid fa-check",
      "Marcar pagas",
      0,
      "Marcando..."
    );
    setBulkActionButtonState(
      "btnBulkNotify",
      "notify",
      "fa-brands fa-whatsapp",
      "Enviar lembrete",
      0,
      "Enviando..."
    );
    setBulkActionButtonState(
      "btnBulkCancel",
      "cancel",
      "fa-solid fa-ban",
      "Cancelar",
      0,
      "Cancelando..."
    );
    clearButton.innerHTML = `<i class="fa-solid fa-xmark"></i> Limpar seleção`;
    clearButton.disabled = true;
    return;
  }

  count.textContent = `${total} cobrança(s) selecionada(s)`;

  const infoParts = [];
  if (stats.payEligible.length > 0) {
    infoParts.push(`${stats.payEligible.length} para pagamento`);
  }
  if (stats.notifyEligible.length > 0) {
    infoParts.push(`${stats.notifyEligible.length} para lembrete via WhatsApp`);
  }
  if (stats.cancelEligible.length > 0) {
    infoParts.push(`${stats.cancelEligible.length} para cancelamento`);
  }
  if (stats.ignoredCount > 0) {
    infoParts.push(`${stats.ignoredCount} paga(s) ou cancelada(s) ficam fora do lote`);
  }

  hint.textContent = infoParts.length
    ? infoParts.join(" - ")
    : "Selecione cobranças pendentes ou vencidas para usar ações em lote.";

  setBulkActionButtonState(
    "btnBulkPay",
    "pay",
    "fa-solid fa-check",
    "Marcar pagas",
    stats.payEligible.length,
    "Marcando..."
  );
  setBulkActionButtonState(
    "btnBulkNotify",
    "notify",
    "fa-brands fa-whatsapp",
    "Enviar lembrete",
    stats.notifyEligible.length,
    "Enviando..."
  );
  setBulkActionButtonState(
    "btnBulkCancel",
    "cancel",
    "fa-solid fa-ban",
    "Cancelar",
    stats.cancelEligible.length,
    "Cancelando..."
  );

  clearButton.innerHTML = `<i class="fa-solid fa-xmark"></i> Limpar seleção`;
  clearButton.disabled = Boolean(State.bulkActionLoading);
}

async function loadCobrancas() {
  const tbody = document.getElementById("cobrancasTableBody");
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-loading">Carregando cobranças...</td>
      </tr>
    `;
  }

  syncActiveCobrancaShortcut();
  const qs = buildCobrancasQueryParams({
    page: State.page,
    pageSize: 15,
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
    pruneSelectedChargeIds();
    if (requestedPage > State.pages && State.total > 0) {
      State.page = State.pages;
      await loadCobrancas();
      return;
    }

    renderCobrancasTable();
    renderPaginacao();
    syncSelectedChargesUi();
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
        <td colspan="7">
          <div class="empty-state-cob">
            <i class="fa-solid fa-file-invoice"></i>
            <p>Nenhuma cobrança encontrada</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const selectedIds = new Set(getSelectedChargeIds());

  tbody.innerHTML = State.cobrancas
    .map((c) => {
      const urgency = getChargeUrgencyMeta(c);
      const rowClasses = [
        selectedIds.has(Number(c.id)) ? "is-selected" : "",
        urgency?.rowClass || "",
      ]
        .filter(Boolean)
        .join(" ");

      return `
      <tr class="${rowClasses}">
        <td class="checkbox-col">
          <label class="table-checkbox" aria-label="Selecionar cobrança">
            <input
              type="checkbox"
              class="cobranca-row-checkbox"
              value="${Number(c.id)}"
              ${selectedIds.has(Number(c.id)) ? "checked" : ""}
              onchange="toggleCobrancaSelection(${Number(c.id)}, this.checked)"
            />
          </label>
        </td>
        <td>
          <div class="cliente-cell">
            <button
              type="button"
              class="cliente-link-button"
              onclick="abrirClienteDashboard(${Number(c.cliente_id)})"
            >
              <strong>${escHtml(c.cliente_nome)}</strong>
              <i class="fa-solid fa-arrow-up-right-from-square"></i>
            </button>
            <div class="cliente-subinfo">${escHtml(formatPhoneDisplay(c.cliente_telefone))}</div>
          </div>
        </td>
        <td>${formatBillingType(c.billing_type)}</td>
        <td class="valor-col">${formatCurrency(c.valor)}</td>
        <td>
          <div class="vencimento-cell">
            <span>${formatDate(c.vencimento)}</span>
            ${urgency
              ? `
                <span class="urgency-chip ${urgency.chipClass}" title="${escAttr(urgency.title)}">
                  ${escHtml(urgency.label)}
                </span>
              `
              : ""}
            ${Number(c.parcelas) > 1 && Number(c.parcela_atual) > 0
              ? `<div class="cliente-subinfo">${Number(c.parcela_atual)}/${Number(c.parcelas)}x</div>`
              : ""}
          </div>
        </td>
        <td>
          <div class="status-cell-stack">
            <span class="badge-status badge-${c.status}">${formatStatus(c.status)}</span>
            ${buildChargeMpStatusHtml(c)}
            ${buildChargeWhatsappStatusHtml(c)}
          </div>
        </td>
        <td>
          <div class="table-actions">
            <button class="btn-table-action" title="Ver detalhes" onclick="abrirDetalhes(${Number(c.id)})">
              <i class="fa-solid fa-eye"></i>
            </button>
            ${canRegisterChargeReceipt(c)
              ? `
                <button class="btn-table-action success" title="${c.status === "PARCIAL" ? "Adicionar recebimento" : "Marcar como pago"}" onclick="abrirModalPagar(${Number(c.id)})">
                  <i class="fa-solid ${c.status === "PARCIAL" ? "fa-plus" : "fa-check"}"></i>
                </button>
              `
              : ""}
            ${canOpenMpCheckout(c)
              ? `
                <button class="btn-table-action checkout" title="${c.mp_checkout_url ? "Abrir checkout online" : "Gerar link de pagamento"}" onclick="abrirModalMpCheckout(${Number(c.id)})">
                  <i class="fa-solid fa-wallet"></i>
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
    `;
    })
    .join("");
}

function abrirModalNovaCobranca() {
  limparFormCobranca();
  abrirModal("modalNovaCobranca");
}

function limparFormCobranca() {
  const form = document.getElementById("formNovaCobranca");
  form?.reset();
  document.getElementById("cbClienteId").value = "";
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
    cliente_id: Number(document.getElementById("cbClienteId").value || 0) || undefined,
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
    await Promise.all([
      loadSummary(),
      loadFinancialHealth(),
      loadCobrancas(),
      loadRecorrencias(),
      loadClientes(),
    ]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro de conexão");
  } finally {
    setButtonLoading(btn, false);
  }
}

async function abrirDetalhesOverride(id) {
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
    const recebimentos = Array.isArray(data.recebimentos) ? data.recebimentos : [];
    const resumo = data.resumo || {};
    const totalRecebido = Number(resumo.total_recebido ?? c.valor_pago ?? 0);
    const saldoAberto = Math.max(
      0,
      Number(resumo.saldo_aberto ?? (Number(c.valor || 0) - totalRecebido))
    );
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

      ${buildChargeMpDetailsSectionHtml(c)}
    `;

    footer.innerHTML = `
      <button class="btn-ghost-cob" onclick="fecharModal('modalDetalhes')">Fechar</button>
      ${canOpenMpCheckout(c)
        ? `
          <button class="btn-ghost-cob" onclick="fecharModal('modalDetalhes');abrirModalMpCheckout(${Number(c.id)})">
            <i class="fa-solid fa-wallet"></i> Checkout
          </button>
        `
        : ""}
      <button class="btn-ghost-cob" onclick="enviarWhatsAppManual(${Number(c.id)})">
        <i class="fa-brands fa-whatsapp"></i> Enviar WPP
      </button>
      ${canRegisterChargeReceipt(c)
        ? `
          <button class="btn-primary-cob" onclick="fecharModal('modalDetalhes');abrirModalPagar(${Number(c.id)})">
            <i class="fa-solid ${c.status === "PARCIAL" ? "fa-plus" : "fa-check"}"></i>
            ${c.status === "PARCIAL" ? "Adicionar recebimento" : "Marcar como pago"}
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
    await Promise.all([
      loadSummary(),
      loadFinancialHealth(),
      loadCobrancas(),
      loadRecorrencias(),
    ]);
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
    await Promise.all([
      loadSummary(),
      loadFinancialHealth(),
      loadCobrancas(),
      loadRecorrencias(),
    ]);
  } catch (err) {
    console.error(err);
    showToast("error", "Erro ao cancelar cobrança");
  }
}

function nextWhatsAppPreviewRequestId() {
  State.whatsappPreviewRequestId = Number(State.whatsappPreviewRequestId || 0) + 1;
  return State.whatsappPreviewRequestId;
}

function resetWhatsAppPreviewState() {
  State.whatsappPreviewCharge = null;
  State.whatsappPreviewType = "";
}

function getManualWhatsAppTipo(charge) {
  if (charge?.status === "VENCIDO") return "atraso";
  if (charge?.status === "PARCIAL") {
    const today = formatDateInputLocal(getTodayReferenceLocal());
    return String(charge?.vencimento || "") < today ? "atraso" : "lembrete_vencimento";
  }
  if (charge?.status === "PENDENTE") return "lembrete_vencimento";
  return "criacao";
}

function getManualWhatsAppTipoLabel(tipo) {
  const map = {
    criacao: "Nova cobran\u00E7a",
    lembrete_vencimento: "Lembrete de vencimento",
    atraso: "Cobran\u00E7a em atraso",
    confirmacao_pagamento: "Confirma\u00E7\u00E3o de pagamento",
    cancelamento: "Cancelamento",
  };
  return map[tipo] || "Mensagem de cobran\u00E7a";
}

function getPlainChargeStatus(status) {
  const map = {
    PENDENTE: "Pendente",
    PAGO: "Pago",
    VENCIDO: "Vencido",
    CANCELADO: "Cancelado",
    PARCIAL: "Parcial",
  };
  return map[status] || String(status || "Sem status");
}

function getChargeWhatsappStatusMeta(charge) {
  const status = String(charge?.whatsapp_ultimo_status || "").trim();
  if (!status) return null;

  const tipoLabel = getManualWhatsAppTipoLabel(charge?.whatsapp_ultimo_tipo);
  const statusAt =
    Number(charge?.whatsapp_ultimo_lido_em || 0) ||
    Number(charge?.whatsapp_ultimo_entregue_em || 0) ||
    Number(charge?.whatsapp_ultimo_envio_em || 0) ||
    Number(charge?.whatsapp_ultimo_status_em || 0);
  const whenText = statusAt ? ` em ${formatRecebimentoDateTime(statusAt)}` : "";
  const errorText = charge?.whatsapp_ultimo_erro
    ? ` • ${String(charge.whatsapp_ultimo_erro).trim()}`
    : "";

  if (status === "READ") {
    return {
      icon: "fa-check-double",
      label: "Lida",
      className: "is-read",
      title: `${tipoLabel} lida${whenText}`,
    };
  }

  if (status === "DELIVERED") {
    return {
      icon: "fa-check-double",
      label: "Entregue",
      className: "is-delivered",
      title: `${tipoLabel} entregue${whenText}`,
    };
  }

  if (status === "FAILED") {
    return {
      icon: "fa-circle-exclamation",
      label: "Falhou",
      className: "is-failed",
      title: `${tipoLabel} com falha${whenText}${errorText}`,
    };
  }

  return {
    icon: "fa-check",
    label: "Enviada",
    className: "is-sent",
    title: `${tipoLabel} enviada${whenText}`,
  };
}

function buildChargeWhatsappStatusHtml(charge) {
  const meta = getChargeWhatsappStatusMeta(charge);
  if (!meta) return "";

  return `
    <span class="whatsapp-delivery-indicator ${meta.className}" title="${escAttr(meta.title)}">
      <i class="fa-solid ${meta.icon}"></i>
      <span>${escHtml(meta.label)}</span>
    </span>
  `;
}

function diffDateInputValues(fromDate, toDate) {
  const from = parseDateOnlyLocal(fromDate);
  const to = parseDateOnlyLocal(toDate);
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / CHARGE_DAY_MS);
}

function addDaysToDateInput(dateStr, days) {
  const date = parseDateOnlyLocal(dateStr);
  if (!date) return "";

  const nextDate = new Date(date.getTime());
  nextDate.setDate(nextDate.getDate() + Number(days || 0));
  return formatDateInputLocal(nextDate);
}

function roundChargeMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function formatChargeNumeric(value) {
  return String(roundChargeMoney(value));
}

function findChargeById(id) {
  const numericId = Number(id);
  return State.cobrancas.find((item) => Number(item.id) === numericId) || null;
}

function isParentInstallmentCharge(charge) {
  return (
    charge &&
    !charge.cobranca_pai_id &&
    Number(charge.parcelas || 1) > 1 &&
    Number(charge.parcela_atual || 0) <= 0
  );
}

function canRegisterChargeReceipt(charge) {
  if (!charge || isParentInstallmentCharge(charge)) return false;
  return (
    charge.status === "PENDENTE" ||
    charge.status === "VENCIDO" ||
    charge.status === "PARCIAL"
  );
}

function canOpenMpCheckout(charge) {
  if (!charge || isParentInstallmentCharge(charge)) return false;
  if (charge.status === "CANCELADO") return Boolean(charge.mp_checkout_url);
  if (charge.status === "PAGO") return Boolean(charge.mp_checkout_url);
  return true;
}

function getMpStatusMeta(status, hasLink) {
  const normalized = String(status || "").trim().toLowerCase();

  if (normalized === "approved") {
    return {
      label: "Pago online",
      shortLabel: "Pago",
      badgeClass: "badge-mp-approved",
      icon: "fa-solid fa-credit-card",
    };
  }

  if (
    normalized === "cancelled" ||
    normalized === "rejected" ||
    normalized === "charged_back" ||
    normalized === "refunded"
  ) {
    return {
      label: "Link encerrado",
      shortLabel: "Encerrado",
      badgeClass: "badge-mp-closed",
      icon: "fa-solid fa-link-slash",
    };
  }

  if (hasLink) {
    return {
      label: "Link ativo",
      shortLabel: "Aguardando",
      badgeClass: "badge-mp-pending",
      icon: "fa-solid fa-link",
    };
  }

  return null;
}

function getChargeMpMeta(charge) {
  if (!charge) return null;
  const hasLink = Boolean(String(charge.mp_checkout_url || "").trim());
  const status = String(charge.mp_status || "").trim();
  if (!hasLink && !status) return null;

  const statusMeta = getMpStatusMeta(status, hasLink);
  if (!statusMeta) return null;

  return {
    ...statusMeta,
    checkoutUrl: String(charge.mp_checkout_url || "").trim(),
    paymentId: String(charge.mp_payment_id || "").trim(),
    preferenceId: String(charge.mp_preference_id || "").trim(),
    updatedAt: Number(charge.mp_updated_at || 0) || null,
    rawStatus: status,
  };
}

function buildChargeMpStatusHtml(charge) {
  const meta = getChargeMpMeta(charge);
  if (!meta) return "";

  const titleParts = [meta.label];
  if (meta.rawStatus) {
    titleParts.push(`Status MP: ${meta.rawStatus}`);
  }
  if (meta.updatedAt) {
    titleParts.push(`Atualizado em ${formatRecebimentoDateTime(meta.updatedAt)}`);
  }

  return `
    <span class="badge-status ${meta.badgeClass}" title="${escAttr(titleParts.join(" | "))}">
      <i class="${meta.icon}"></i>
      ${escHtml(meta.label)}
    </span>
  `;
}

function buildChargeMpDetailsSectionHtml(charge) {
  const meta = getChargeMpMeta(charge);
  if (!meta) return "";

  return `
    <div class="mp-details-section">
      <div class="mp-details-head">
        <div>
          <span class="mp-details-kicker">Checkout online</span>
          <strong>Mercado Pago</strong>
        </div>
        <span class="badge-status ${meta.badgeClass}">
          <i class="${meta.icon}"></i>
          ${escHtml(meta.shortLabel)}
        </span>
      </div>

      ${meta.checkoutUrl
        ? `
          <div class="copy-line">
            <span class="copy-line-text">${escHtml(meta.checkoutUrl)}</span>
            <button class="copy-btn" onclick='copyToClipboard(${quoteJs(meta.checkoutUrl)})'>
              <i class="fa-solid fa-copy"></i> Copiar
            </button>
          </div>
        `
        : ""}

      <div class="mp-details-meta">
        ${meta.rawStatus
          ? `<span>Status MP: ${escHtml(meta.rawStatus)}</span>`
          : ""}
        ${meta.updatedAt
          ? `<span>Atualizado ${escHtml(formatRelativeTime(meta.updatedAt))}</span>`
          : ""}
      </div>
    </div>
  `;
}

function getChargeRemainingValue(charge) {
  return Math.max(0, Number(charge?.valor || 0) - Number(charge?.valor_pago || 0));
}

function formatRecebimentoDateTime(value) {
  if (!value) return "Data não informada";
  const date = new Date(Number(value));
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "agora h\u00e1 pouco";

  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora h\u00e1 pouco";
  if (minutes === 1) return "h\u00e1 1 minuto";
  if (minutes < 60) return `h\u00e1 ${minutes} minutos`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "h\u00e1 1 hora";
  if (hours < 24) return `h\u00e1 ${hours} horas`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "h\u00e1 1 dia";
  return `h\u00e1 ${days} dias`;
}

function buildRecebimentosHtml(recebimentos, resumo) {
  if (!Array.isArray(recebimentos) || !recebimentos.length) {
    const fallbackMessage = resumo?.historico_disponivel === false
      ? `Esta cobrança já possui ${formatCurrency(resumo.total_recebido || 0)} recebido, mas os lançamentos antigos ainda não têm histórico detalhado.`
      : "Ainda não há recebimentos registrados para esta cobrança.";

    return `<div class="recebimentos-empty">${escHtml(fallbackMessage)}</div>`;
  }

  return `
    <div class="recebimentos-list">
      ${recebimentos
        .map((item) => `
          <div class="recebimento-item">
            <div class="recebimento-head">
              <span class="recebimento-date">${escHtml(formatRecebimentoDateTime(item.recebido_em))}</span>
              <strong class="recebimento-value">${formatCurrency(item.valor)}</strong>
            </div>
            ${item.observacao
              ? `<div class="recebimento-note">${escHtml(item.observacao)}</div>`
              : ""}
          </div>
        `)
        .join("")}
    </div>
  `;
}

function updatePaymentModalContext(id) {
  const charge = findChargeById(id);
  const remainingValue = getChargeRemainingValue(charge);
  const input = document.getElementById("pagarValor");
  const helper = document.getElementById("pagarResumoAjuda");

  if (input) {
    input.placeholder = remainingValue > 0
      ? `Deixe vazio para quitar ${formatCurrency(remainingValue)}`
      : "Informe o valor recebido";
  }

  if (helper) {
    helper.textContent = remainingValue > 0
      ? `Saldo restante: ${formatCurrency(remainingValue)}. Se informar um valor menor, a cobrança ficará parcial.`
      : "Informe o valor recebido nesta cobrança.";
  }
}

function calculatePreviewDiscountDeadline(vencimento, descontoLimiteDias) {
  const dueDate = String(vencimento || "").trim();
  const daysLimit = Number(descontoLimiteDias || 0);
  if (!dueDate || daysLimit <= 0) return "";
  return addDaysToDateInput(dueDate, -daysLimit);
}

function calculatePreviewDiscountedValue(charge) {
  const percentage = Number(charge?.desconto_percentual || 0);
  const dueDate = String(charge?.vencimento || "").trim();
  const daysLimit = Number(charge?.desconto_limite_dias || 0);

  if (!percentage || percentage <= 0 || !dueDate || daysLimit <= 0) {
    return null;
  }

  const deadline = calculatePreviewDiscountDeadline(dueDate, daysLimit);
  if (!deadline) return null;

  const today = formatDateInputLocal(getTodayReferenceLocal());
  if (diffDateInputValues(deadline, today) > 0) {
    return null;
  }

  return roundChargeMoney(Number(charge?.valor || 0) * (1 - percentage / 100));
}

function buildManualChargeEncargos(charge) {
  const items = [];

  if (Number(charge?.multa_percentual || 0) > 0) {
    items.push(`Multa: ${formatChargeNumeric(charge.multa_percentual)}%`);
  }
  if (Number(charge?.juros_percentual || 0) > 0) {
    items.push(`Juros: ${formatChargeNumeric(charge.juros_percentual)}% ao m\u00EAs`);
  }

  return items.join(" | ");
}

function buildManualChargeExtras(charge) {
  const lines = [];
  const discountedValue = calculatePreviewDiscountedValue(charge);
  const discountDeadline = calculatePreviewDiscountDeadline(
    charge?.vencimento,
    charge?.desconto_limite_dias
  );
  const parcelas = Number(charge?.parcelas || 0);
  const parcelaAtual = Number(charge?.parcela_atual || 0);

  if (discountedValue != null && discountDeadline) {
    lines.push(
      `\u{1F3F7}\uFE0F *Pagamento com desconto at\u00E9 ${formatDate(discountDeadline)}:* ${formatCurrency(discountedValue)}`
    );
  }

  if (charge?.billing_type === "PIX" && charge?.chave_pix) {
    lines.push(`\u{1F511} *Chave PIX:* ${charge.chave_pix}`);
  }

  if (charge?.link_pagamento) {
    lines.push(`\u{1F517} *Link para pagamento:* ${charge.link_pagamento}`);
  }

  if (parcelas > 1 && parcelaAtual > 0) {
    lines.push(`\u{1F9FE} *Parcela:* ${parcelaAtual}/${parcelas}`);
  }

  return lines.join("\n");
}

function buildManualChargePreviewMessage(charge, tipo) {
  const fullName = String(charge?.cliente_nome || "").trim();
  const firstName = fullName ? fullName.split(/\s+/)[0] : "{nome}";
  const valor = roundChargeMoney(charge?.valor || 0);
  const valorPago =
    charge?.valor_pago === null || charge?.valor_pago === undefined
      ? valor
      : roundChargeMoney(charge.valor_pago);
  const dueDate = String(charge?.vencimento || "").trim();
  const today = formatDateInputLocal(getTodayReferenceLocal());
  const dueDiff = dueDate ? diffDateInputValues(today, dueDate) : 0;
  const whenDue =
    dueDiff <= 0 ? "hoje" : dueDiff === 1 ? "amanh\u00E3" : `em ${dueDiff} dias`;
  const lateDays = dueDate ? Math.max(1, diffDateInputValues(dueDate, today)) : 1;
  const paidAt = charge?.pago_em
    ? new Date(Number(charge.pago_em)).toLocaleDateString("pt-BR")
    : "\u2014";

  return buildChargePreviewMessage(tipo, {
    nome: fullName || "{nome}",
    primeiro_nome: firstName,
    valor: formatCurrency(valor),
    valor_pago: formatCurrency(valorPago),
    vencimento: formatDate(dueDate),
    data_pagamento: paidAt,
    forma_pagamento: formatBillingTypeText(charge?.billing_type || ""),
    descricao: charge?.descricao || "",
    observacoes: charge?.observacoes || "",
    chave_pix: charge?.chave_pix || "",
    link_pagamento: charge?.link_pagamento || "",
    quando_vence: whenDue,
    dias_atraso: lateDays,
    encargos: buildManualChargeEncargos(charge),
    extras: buildManualChargeExtras(charge),
  });
}

function renderWhatsAppPreviewLoading() {
  const cliente = document.getElementById("whatsPreviewCliente");
  const tipo = document.getElementById("whatsPreviewTipo");
  const telefone = document.getElementById("whatsPreviewTelefone");
  const status = document.getElementById("whatsPreviewStatus");
  const content = document.getElementById("whatsPreviewContent");
  const hint = document.getElementById("whatsPreviewHint");
  const button = document.getElementById("btnConfirmarWhatsPreview");

  if (cliente) cliente.textContent = "Carregando...";
  if (tipo) tipo.textContent = "Preparando preview";
  if (telefone) telefone.textContent = "Buscando WhatsApp";
  if (status) status.textContent = "Buscando status";
  if (content) content.textContent = "Carregando preview da mensagem...";
  if (hint) hint.textContent = "Buscando os dados mais recentes da cobrança.";

  if (button) {
    if (typeof setButtonLoading === "function") setButtonLoading(button, false);
    button.disabled = true;
  }
}

function renderWhatsAppPreviewError(message) {
  const cliente = document.getElementById("whatsPreviewCliente");
  const tipo = document.getElementById("whatsPreviewTipo");
  const telefone = document.getElementById("whatsPreviewTelefone");
  const status = document.getElementById("whatsPreviewStatus");
  const content = document.getElementById("whatsPreviewContent");
  const hint = document.getElementById("whatsPreviewHint");
  const button = document.getElementById("btnConfirmarWhatsPreview");

  if (cliente) cliente.textContent = "Preview indisponível";
  if (tipo) tipo.textContent = "Falha ao montar mensagem";
  if (telefone) telefone.textContent = "WhatsApp indisponível";
  if (status) status.textContent = "Envio bloqueado";
  if (content) {
    content.textContent = message || "Não foi possível carregar o preview da mensagem.";
  }
  if (hint) hint.textContent = "Corrija a cobrança e tente novamente.";

  if (button) {
    if (typeof setButtonLoading === "function") setButtonLoading(button, false);
    button.disabled = true;
  }
}

function renderWhatsAppPreviewModal(charge, tipo) {
  const cliente = document.getElementById("whatsPreviewCliente");
  const tipoEl = document.getElementById("whatsPreviewTipo");
  const telefone = document.getElementById("whatsPreviewTelefone");
  const status = document.getElementById("whatsPreviewStatus");
  const content = document.getElementById("whatsPreviewContent");
  const hint = document.getElementById("whatsPreviewHint");
  const button = document.getElementById("btnConfirmarWhatsPreview");

  if (cliente) cliente.textContent = String(charge?.cliente_nome || "Cliente sem nome");
  if (tipoEl) tipoEl.textContent = getManualWhatsAppTipoLabel(tipo);
  if (telefone) telefone.textContent = formatPhoneDisplay(charge?.cliente_telefone || "");
  if (status) status.textContent = getPlainChargeStatus(charge?.status);
  if (content) content.textContent = buildManualChargePreviewMessage(charge, tipo);
  if (hint) {
    hint.textContent = "As variáveis abaixo já foram renderizadas com os dados reais desta cobrança.";
  }

  if (button) {
    if (typeof setButtonLoading === "function") setButtonLoading(button, false);
    button.disabled = false;
  }
}

function fecharModalWhatsappPreview() {
  nextWhatsAppPreviewRequestId();
  resetWhatsAppPreviewState();
  renderWhatsAppPreviewLoading();
  fecharModal("modalWhatsAppPreview");
}

async function fetchChargeForWhatsAppPreview(id) {
  const res = await fetch(`/api/cobrancas/${id}`);
  let data = {};

  try {
    data = await res.json();
  } catch (err) {
    console.warn("Falha ao ler resposta do preview WhatsApp:", err);
  }

  if (!res.ok || !data?.ok || !data?.cobranca) {
    throw new Error(data?.error || "Não foi possível carregar a cobrança.");
  }

  return data.cobranca;
}

async function sendManualChargeNotificationRequest(id, tipo) {
  const res = await fetch(`/api/cobrancas/${id}/notificar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo }),
  });
  let data = {};

  try {
    data = await res.json();
  } catch (err) {
    console.warn("Falha ao ler resposta do envio manual:", err);
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || "Erro ao enviar. Verifique a sessão WPP.");
  }

  return data;
}

async function openWhatsAppPreviewManual(id) {
  const chargeId = Number(id);
  if (!Number.isFinite(chargeId) || chargeId <= 0) return;

  const requestId = nextWhatsAppPreviewRequestId();
  resetWhatsAppPreviewState();
  renderWhatsAppPreviewLoading();
  abrirModal("modalWhatsAppPreview");

  try {
    const charge = await fetchChargeForWhatsAppPreview(chargeId);
    if (requestId !== State.whatsappPreviewRequestId) return;

    const tipo = getManualWhatsAppTipo(charge);
    State.whatsappPreviewCharge = charge;
    State.whatsappPreviewType = tipo;
    renderWhatsAppPreviewModal(charge, tipo);
  } catch (err) {
    if (requestId !== State.whatsappPreviewRequestId) return;

    console.error(err);
    renderWhatsAppPreviewError(err?.message || "Erro ao carregar preview do WhatsApp");
    showToast("error", err?.message || "Erro ao carregar preview do WhatsApp");
  }
}

async function confirmarEnvioWhatsAppManual() {
  const charge = State.whatsappPreviewCharge;
  const tipo = State.whatsappPreviewType;
  const button = document.getElementById("btnConfirmarWhatsPreview");
  const chargeId = Number(charge?.id || 0);

  if (!chargeId || !tipo) {
    showToast("warn", "Abra o preview da mensagem antes de enviar.");
    return;
  }

  if (typeof setButtonLoading === "function") {
    setButtonLoading(button, true, "Enviando...");
  } else if (button) {
    button.disabled = true;
  }

  try {
    await sendManualChargeNotificationRequest(chargeId, tipo);
    fecharModalWhatsappPreview();
    showToast("success", "Mensagem enviada via WhatsApp!");

    if (State.currentDetalhesId === chargeId) {
      abrirDetalhes(chargeId);
    }
  } catch (err) {
    console.error(err);
    showToast("error", err?.message || "Erro ao enviar WhatsApp");
  } finally {
    if (button) {
      if (typeof setButtonLoading === "function") setButtonLoading(button, false);
      button.disabled = State.whatsappPreviewCharge ? false : button.disabled;
    }
  }
}

async function enviarWhatsAppManual(id) {
  return openWhatsAppPreviewManual(id);

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

function syncChargeInState(charge) {
  if (!charge || !Number(charge.id)) return;
  const index = State.cobrancas.findIndex((item) => Number(item.id) === Number(charge.id));
  if (index >= 0) {
    State.cobrancas[index] = {
      ...State.cobrancas[index],
      ...charge,
    };
  } else {
    State.cobrancas = [charge, ...State.cobrancas];
  }

  renderCobrancasTable();
}

function setMpCheckoutModalState(contentHtml, footerHtml = "") {
  const content = document.getElementById("mpCheckoutContent");
  const footer = document.getElementById("mpCheckoutFooter");
  if (content) content.innerHTML = contentHtml;
  if (footer) footer.innerHTML = footerHtml;
}

function renderMpCheckoutLoading(message = "Preparando checkout do Mercado Pago...") {
  setMpCheckoutModalState(
    `<div class="table-loading">${escHtml(message)}</div>`,
    `<button class="btn-ghost-cob" onclick="fecharModal('modalMpCheckout')">Fechar</button>`
  );
}

function renderMpCheckoutError(message, chargeId) {
  setMpCheckoutModalState(
    `
      <div class="mp-checkout-state mp-checkout-state-error">
        <div class="mp-checkout-state-icon">
          <i class="fa-solid fa-circle-exclamation"></i>
        </div>
        <div>
          <strong>Não foi possível abrir o checkout online</strong>
          <p>${escHtml(message || "Tente novamente em instantes.")}</p>
        </div>
      </div>
    `,
    `
      <button class="btn-ghost-cob" onclick="fecharModal('modalMpCheckout')">Fechar</button>
      ${chargeId
        ? `<button class="btn-primary-cob" onclick="abrirModalMpCheckout(${Number(chargeId)})"><i class="fa-solid fa-rotate"></i> Tentar novamente</button>`
        : ""}
    `
  );
}

function renderMpCheckoutNeedsConfiguration() {
  setMpCheckoutModalState(
    `
      <div class="mp-checkout-state mp-checkout-state-warning">
        <div class="mp-checkout-state-icon">
          <i class="fa-solid fa-triangle-exclamation"></i>
        </div>
        <div>
          <strong>Configure o Mercado Pago</strong>
          <p>Para gerar links de pagamento online, conecte sua conta em Minha Conta.</p>
        </div>
      </div>
    `,
    `
      <button class="btn-ghost-cob" onclick="fecharModal('modalMpCheckout')">Fechar</button>
      <a class="btn-primary-cob" href="/user#mercadopago">
        <i class="fa-solid fa-gear"></i> Configurar agora
      </a>
    `
  );
}

function renderMpCheckoutCreateState(charge) {
  setMpCheckoutModalState(
    `
      <div class="mp-checkout-panel">
        <div class="mp-checkout-headline">
          <span class="mp-checkout-kicker">Checkout Pro</span>
          <h3>Gerar link de pagamento</h3>
          <p>O link online fica atrelado a esta cobrança e pode ser copiado ou enviado direto no WhatsApp.</p>
        </div>

        <div class="mp-checkout-summary-grid">
          <div class="mp-checkout-summary-card">
            <label>Valor</label>
            <strong>${formatCurrency(charge.valor)}</strong>
          </div>
          <div class="mp-checkout-summary-card">
            <label>Vencimento</label>
            <strong>${formatDate(charge.vencimento)}</strong>
          </div>
          <div class="mp-checkout-summary-card mp-summary-span">
            <label>Descrição</label>
            <strong>${escHtml(charge.descricao)}</strong>
          </div>
        </div>

        <label class="switch-line mp-checkout-toggle">
          <input type="checkbox" id="mpExpireOnDueDate" checked />
          <span>Expirar link no vencimento</span>
        </label>
      </div>
    `,
    `
      <button class="btn-ghost-cob" onclick="fecharModal('modalMpCheckout')">Fechar</button>
      <button class="btn-primary-cob" id="btnGenerateMpCopy" onclick="gerarLinkMercadoPago(${Number(charge.id)}, false, false)">
        <i class="fa-solid fa-copy"></i> Gerar e copiar link
      </button>
      <button class="btn-primary-cob" id="btnGenerateMpSend" onclick="gerarLinkMercadoPago(${Number(charge.id)}, true, false)">
        <i class="fa-brands fa-whatsapp"></i> Gerar e enviar por WhatsApp
      </button>
    `
  );
}

function renderMpCheckoutActiveState(charge, syncError = "") {
  const meta = getChargeMpMeta(charge) || {
    label: "Link ativo",
    shortLabel: "Aguardando",
    badgeClass: "badge-mp-pending",
    icon: "fa-solid fa-link",
    checkoutUrl: String(charge?.mp_checkout_url || "").trim(),
    updatedAt: Number(charge?.mp_updated_at || 0) || null,
    rawStatus: String(charge?.mp_status || "").trim(),
  };

  setMpCheckoutModalState(
    `
      <div class="mp-checkout-panel">
        <div class="mp-checkout-headline">
          <span class="mp-checkout-kicker">Checkout online</span>
          <h3>Link de pagamento</h3>
          <p>Compartilhe o checkout com o cliente ou acompanhe o status do pagamento em tempo real.</p>
        </div>

        <div class="mp-checkout-status-row">
          <span class="badge-status ${meta.badgeClass}">
            <i class="${meta.icon}"></i>
            ${escHtml(meta.shortLabel)}
          </span>
          <span class="mp-checkout-updated">
            ${meta.updatedAt ? `Atualizado ${escHtml(formatRelativeTime(meta.updatedAt))}` : "Aguardando primeira atualização"}
          </span>
        </div>

        <div class="copy-line">
          <span class="copy-line-text">${escHtml(meta.checkoutUrl || "")}</span>
          <button class="copy-btn" onclick='copyToClipboard(${quoteJs(meta.checkoutUrl || "")})'>
            <i class="fa-solid fa-copy"></i> Copiar
          </button>
        </div>

        <div class="mp-checkout-grid">
          <div class="mp-checkout-qr-wrap">
            <div class="mp-checkout-qr" id="mpCheckoutQr"></div>
          </div>
          <div class="mp-checkout-meta-card">
            <div>
              <span>Status MP</span>
              <strong>${escHtml(meta.rawStatus || "pending")}</strong>
            </div>
            ${charge.mp_payment_id
              ? `
                <div>
                  <span>Pagamento</span>
                  <strong>${escHtml(String(charge.mp_payment_id))}</strong>
                </div>
              `
              : ""}
            ${charge.mp_preference_id
              ? `
                <div>
                  <span>Preference</span>
                  <strong>${escHtml(String(charge.mp_preference_id))}</strong>
                </div>
              `
              : ""}
            <div>
              <span>Valor</span>
              <strong>${formatCurrency(charge.valor)}</strong>
            </div>
          </div>
        </div>

        ${syncError
          ? `<div class="mp-checkout-warning">${escHtml(syncError)}</div>`
          : ""}
      </div>
    `,
    `
      <button class="btn-ghost-cob" onclick="fecharModal('modalMpCheckout')">Fechar</button>
      <button class="btn-ghost-cob" onclick='copyToClipboard(${quoteJs(meta.checkoutUrl || "")})'>
        <i class="fa-solid fa-copy"></i> Copiar link
      </button>
      <button class="btn-primary-cob" id="btnSendMpExisting" onclick="enviarLinkMercadoPagoWhatsApp(${Number(charge.id)})">
        <i class="fa-brands fa-whatsapp"></i> Enviar por WhatsApp
      </button>
      ${charge.status !== "PAGO" && charge.status !== "CANCELADO"
        ? `
          <button class="btn-ghost-cob" id="btnRecreateMpLink" onclick="gerarLinkMercadoPago(${Number(charge.id)}, false, true)">
            <i class="fa-solid fa-rotate"></i> Recriar link
          </button>
        `
        : ""}
    `
  );

  if (meta.checkoutUrl) {
    setTimeout(() => mountMpCheckoutQr(meta.checkoutUrl), 0);
  }
}

function mountMpCheckoutQr(url) {
  const target = document.getElementById("mpCheckoutQr");
  if (!target) return;

  target.innerHTML = "";

  if (!url) {
    target.innerHTML = `<span class="mp-checkout-qr-empty">Link indisponível</span>`;
    return;
  }

  if (typeof QRCode !== "function") {
    target.innerHTML = `<span class="mp-checkout-qr-empty">QR Code indisponível</span>`;
    return;
  }

  new QRCode(target, {
    text: url,
    width: 176,
    height: 176,
  });
}

function getMpExpireOnDueDateValue() {
  const input = document.getElementById("mpExpireOnDueDate");
  if (!input) return true;
  return input.checked !== false;
}

async function fetchMpChargeStatus(id) {
  const response = await fetch(`/api/cobrancas/${id}/mp-status`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Erro ao consultar checkout online.");
  }

  return data;
}

async function abrirModalMpCheckout(id) {
  const chargeId = Number(id);
  if (!Number.isFinite(chargeId) || chargeId <= 0) return;

  State.currentMpCheckoutChargeId = chargeId;
  renderMpCheckoutLoading();
  abrirModal("modalMpCheckout");

  try {
    const data = await fetchMpChargeStatus(chargeId);
    const charge = data.cobranca;
    if (!charge) {
      throw new Error("Cobrança não encontrada.");
    }

    syncChargeInState(charge);

    if (!data.configured) {
      renderMpCheckoutNeedsConfiguration();
      return;
    }

    if (charge.mp_checkout_url) {
      renderMpCheckoutActiveState(charge, data.syncError || "");
      return;
    }

    renderMpCheckoutCreateState(charge);
  } catch (error) {
    console.error(error);
    renderMpCheckoutError(error?.message || "Erro ao abrir checkout online.", chargeId);
  }
}

async function gerarLinkMercadoPago(id, enviarWhatsapp = false, force = false) {
  const chargeId = Number(id);
  if (!Number.isFinite(chargeId) || chargeId <= 0) return;

  const buttonId = enviarWhatsapp ? "btnGenerateMpSend" : force ? "btnRecreateMpLink" : "btnGenerateMpCopy";
  const button = document.getElementById(buttonId);
  setButtonLoading(
    button,
    true,
    enviarWhatsapp ? "Gerando..." : force ? "Recriando..." : "Gerando..."
  );

  try {
    const response = await fetch(`/api/cobrancas/${chargeId}/mp-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expire_on_due_date: getMpExpireOnDueDateValue(),
        enviar_whatsapp: Boolean(enviarWhatsapp),
        force: Boolean(force),
      }),
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 412 || data?.needs_configuration) {
      renderMpCheckoutNeedsConfiguration();
      return;
    }

    if (!response.ok || !data.ok || !data.cobranca) {
      throw new Error(data.error || "Erro ao gerar link de pagamento.");
    }

    syncChargeInState(data.cobranca);
    renderMpCheckoutActiveState(data.cobranca);

    if (!enviarWhatsapp && data.checkoutUrl) {
      await copyToClipboard(data.checkoutUrl);
      return;
    }

    if (data.whatsapp && data.whatsapp.ok === false) {
      showToast("success", force ? "Link recriado com sucesso!" : "Link gerado com sucesso!");
      showToast("warn", data.whatsapp.error || "Link criado, mas não foi possível enviar no WhatsApp.");
    } else {
      showToast("success", force ? "Link recriado e enviado!" : "Link gerado e enviado no WhatsApp!");
    }
  } catch (error) {
    console.error(error);
    showToast("error", error?.message || "Erro ao gerar checkout online");
  } finally {
    setButtonLoading(button, false);
  }
}

async function enviarLinkMercadoPagoWhatsApp(id) {
  const chargeId = Number(id);
  if (!Number.isFinite(chargeId) || chargeId <= 0) return;

  const button = document.getElementById("btnSendMpExisting");
  setButtonLoading(button, true, "Enviando...");

  try {
    const response = await fetch(`/api/cobrancas/${chargeId}/notificar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo: "criacao" }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Erro ao enviar o link no WhatsApp.");
    }

    showToast("success", "Link enviado no WhatsApp!");
  } catch (error) {
    console.error(error);
    showToast("error", error?.message || "Erro ao enviar link no WhatsApp");
  } finally {
    setButtonLoading(button, false);
  }
}

function getBulkEligibleChargeIds(action) {
  const stats = getBulkSelectionStats();

  switch (action) {
    case "pay":
      return stats.payEligible.map((charge) => Number(charge.id));
    case "notify":
      return stats.notifyEligible.map((charge) => Number(charge.id));
    case "cancel":
      return stats.cancelEligible.map((charge) => Number(charge.id));
    default:
      return [];
  }
}

function buildBulkIgnoredSelectionMessage(ignoredCount) {
  return ignoredCount > 0
    ? ` ${ignoredCount} cobrança(s) paga(s) ou cancelada(s) serão ignorada(s).`
    : "";
}

function getBulkActionSuccessMessage(action, successCount) {
  if (action === "pay") {
    return successCount === 1
      ? "1 cobrança marcada como paga."
      : `${successCount} cobranças marcadas como pagas.`;
  }

  if (action === "notify") {
    return successCount === 1
      ? "1 lembrete enviado via WhatsApp."
      : `${successCount} lembretes enviados via WhatsApp.`;
  }

  return successCount === 1
    ? "1 cobrança cancelada."
    : `${successCount} cobranças canceladas.`;
}

function getBulkActionErrorFallback(action) {
  if (action === "pay") return "Erro ao marcar cobranças como pagas";
  if (action === "notify") return "Erro ao enviar lembretes via WhatsApp";
  return "Erro ao cancelar cobranças";
}

function buildBulkActionResultMessage(action, successCount, failureCount, failures = []) {
  const successMessage = getBulkActionSuccessMessage(action, successCount);
  if (failureCount <= 0) return successMessage;

  const firstFailure = Array.isArray(failures) ? failures.find((item) => item?.error) : null;
  const firstFailureText = firstFailure?.error ? ` Primeira falha: ${firstFailure.error}` : "";
  const failureText =
    failureCount === 1
      ? "1 cobrança falhou."
      : `${failureCount} cobranças falharam.`;
  return `${successMessage} ${failureText}${firstFailureText}`;
}

async function executeBulkChargeAction(action, endpoint, payload) {
  if (State.bulkActionLoading) return;

  State.bulkActionLoading = action;
  renderBulkActionsBar();

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const successCount = Number(data?.successCount || 0);
    const failureCount = Number(data?.failureCount || 0);
    const failures = Array.isArray(data?.failures) ? data.failures : [];

    if (!data.ok && successCount <= 0) {
      const firstFailure = failures.find((item) => item?.error)?.error;
      showToast("error", data.error || firstFailure || getBulkActionErrorFallback(action));
      return;
    }

    showToast(
      failureCount > 0 ? "warn" : "success",
      buildBulkActionResultMessage(action, successCount, failureCount, failures)
    );

    if (successCount > 0) {
      clearSelectedCobrancas();
      await Promise.all([
        loadSummary(),
        loadFinancialHealth(),
        loadCobrancas(),
        loadRecorrencias(),
      ]);
    }
  } catch (err) {
    console.error(err);
    showToast("error", getBulkActionErrorFallback(action));
  } finally {
    State.bulkActionLoading = "";
    renderBulkActionsBar();
  }
}

async function bulkMarcarCobrancasComoPagas() {
  const stats = getBulkSelectionStats();
  const ids = getBulkEligibleChargeIds("pay");

  if (!ids.length) {
    showToast("warn", "Selecione cobranças pendentes ou vencidas para marcar como pagas.");
    return;
  }

  const confirmMessage =
    `Marcar ${ids.length} cobrança(s) como paga(s) usando a data de hoje e o valor total?` +
    buildBulkIgnoredSelectionMessage(stats.ignoredCount);

  if (!confirm(confirmMessage)) return;

  await executeBulkChargeAction("pay", "/api/cobrancas/lote/pagar", {
    ids,
    pago_em: formatDateInputLocal(new Date()),
    enviar_confirmacao: false,
  });
}

async function bulkEnviarLembretesWhatsApp() {
  const stats = getBulkSelectionStats();
  const ids = getBulkEligibleChargeIds("notify");

  if (!ids.length) {
    showToast("warn", "Selecione cobranças pendentes ou vencidas para enviar lembretes.");
    return;
  }

  const confirmMessage =
    `Enviar lembrete via WhatsApp para ${ids.length} cobrança(s)?` +
    buildBulkIgnoredSelectionMessage(stats.ignoredCount);

  if (!confirm(confirmMessage)) return;

  await executeBulkChargeAction("notify", "/api/cobrancas/lote/notificar", { ids });
}

async function bulkCancelarCobrancasSelecionadas() {
  const stats = getBulkSelectionStats();
  const ids = getBulkEligibleChargeIds("cancel");

  if (!ids.length) {
    showToast("warn", "Selecione cobranças pendentes ou vencidas para cancelar.");
    return;
  }

  const confirmMessage =
    `Cancelar ${ids.length} cobrança(s) selecionada(s)?` +
    buildBulkIgnoredSelectionMessage(stats.ignoredCount);

  if (!confirm(confirmMessage)) return;

  await executeBulkChargeAction("cancel", "/api/cobrancas/lote/cancelar", {
    ids,
    enviar_whatsapp: false,
  });
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
    await Promise.all([loadRecorrencias(), loadSummary(), loadFinancialHealth()]);
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
    await Promise.all([loadRecorrencias(), loadSummary(), loadFinancialHealth()]);
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
    await Promise.all([
      loadSummary(),
      loadFinancialHealth(),
      loadRecorrencias(),
      loadCobrancas(),
      loadClientes(),
    ]);
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
        <td>
          <button
            type="button"
            class="cliente-link-button"
            onclick="abrirClienteDashboard(${Number(c.id)})"
          >
            <strong>${escHtml(c.nome)}</strong>
            <i class="fa-solid fa-arrow-up-right-from-square"></i>
          </button>
        </td>
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
    await Promise.all([loadClientes(), loadSummary(), loadFinancialHealth()]);
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
    await Promise.all([loadClientes(), loadSummary(), loadFinancialHealth()]);
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
    if (id === "modalMpCheckout") {
      State.currentMpCheckoutChargeId = null;
    }
    updateBodyOverflow();
  }
}

function updateBodyOverflow() {
  const hasOpenModal = document.querySelector(".modal-overlay-cob.open");
  const hasOpenDrawer = document.getElementById("clienteDashboardDrawer")?.classList.contains("open");
  document.body.style.overflow = hasOpenModal || hasOpenDrawer ? "hidden" : "";
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
    if (e.target.id === "modalWhatsAppPreview") {
      fecharModalWhatsappPreview();
      return;
    }
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
    const recebimentos = Array.isArray(data.recebimentos) ? data.recebimentos : [];
    const resumo = data.resumo || {};
    const totalRecebido = Number(resumo.total_recebido ?? c.valor_pago ?? 0);
    const saldoAberto = Math.max(
      0,
      Number(resumo.saldo_aberto ?? (Number(c.valor || 0) - totalRecebido))
    );
    const valorPago = totalRecebido > 0 ? formatCurrency(totalRecebido) : "—";

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

      <div class="detalhe-summary-grid">
        <div class="detalhe-summary-card is-success">
          <label>Total recebido</label>
          <strong>${formatCurrency(totalRecebido)}</strong>
        </div>
        <div class="detalhe-summary-card ${saldoAberto > 0 ? "is-warning" : "is-success"}">
          <label>Saldo restante</label>
          <strong>${formatCurrency(saldoAberto)}</strong>
        </div>
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

      <div class="recebimentos-section">
        <div class="recebimentos-header">
          <h3>Histórico de recebimentos</h3>
          <span class="recebimentos-count">${Number(resumo.quantidade || recebimentos.length)} lançamento(s)</span>
        </div>
        ${buildRecebimentosHtml(recebimentos, resumo)}
      </div>
    `;

    footer.innerHTML = `
      <button class="btn-ghost-cob" onclick="fecharModal('modalDetalhes')">Fechar</button>
      <button class="btn-ghost-cob" onclick="enviarWhatsAppManual(${Number(c.id)})">
        <i class="fa-brands fa-whatsapp"></i> Enviar WPP
      </button>
      ${canRegisterChargeReceipt(c)
        ? `
          <button class="btn-primary-cob" onclick="fecharModal('modalDetalhes');abrirModalPagar(${Number(c.id)}, true)">
            <i class="fa-solid ${c.status === "PARCIAL" ? "fa-plus" : "fa-check"}"></i>
            ${c.status === "PARCIAL" ? "Adicionar recebimento" : "Marcar como pago"}
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

function abrirModalPagarOverride(id, reopenDetalhes = false) {
  State.reopenDetalhesAfterPagamento = Boolean(reopenDetalhes);
  document.getElementById("pagarCobrancaId").value = id;
  document.getElementById("pagarData").value = formatDateInputLocal(new Date());
  document.getElementById("pagarValor").value = "";
  document.getElementById("pagarObservacao").value = "";
  document.getElementById("pagarEnviarConfirmacao").checked = true;
  updatePaymentModalContext(id);
  abrirModal("modalPagar");
}

async function confirmarPagamentoOverride() {
  const id = document.getElementById("pagarCobrancaId").value;
  const valorPagoRaw = document.getElementById("pagarValor").value;
  const valorPago = valorPagoRaw ? parseCurrencyInput(valorPagoRaw) : null;
  const pagoEm = document.getElementById("pagarData").value;
  const observacao = document.getElementById("pagarObservacao").value.trim();
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
        observacao,
        enviar_confirmacao: enviarConfirmacao,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      showToast("error", data.error || "Erro ao confirmar pagamento");
      return;
    }

    const pagamentoParcial = Boolean(data.parcial || data.cobranca?.status === "PARCIAL");
    showToast(
      "success",
      pagamentoParcial ? "Recebimento parcial registrado!" : "Pagamento confirmado!"
    );
    if (data.whatsapp && data.whatsapp.ok === false) {
      showToast("warn", data.whatsapp.error || "Pagamento confirmado, mas o WhatsApp não foi enviado.");
    }

    const reopenDetalhes =
      State.reopenDetalhesAfterPagamento && Number(State.currentDetalhesId) === Number(id);
    State.reopenDetalhesAfterPagamento = false;

    fecharModal("modalPagar");
    await Promise.all([
      loadSummary(),
      loadFinancialHealth(),
      loadCobrancas(),
      loadRecorrencias(),
    ]);
    if (reopenDetalhes) {
      await abrirDetalhesOverride(Number(id));
    }
  } catch (err) {
    console.error(err);
    showToast("error", "Erro de conexão");
  } finally {
    setButtonLoading(btn, false);
  }
}

abrirDetalhes = abrirDetalhesOverride;
abrirModalPagar = abrirModalPagarOverride;
confirmarPagamento = confirmarPagamentoOverride;

function syncClienteDashboardCache(cliente) {
  if (!cliente || !Number(cliente.id)) return;

  const index = State.clientes.findIndex((item) => Number(item.id) === Number(cliente.id));
  if (index >= 0) {
    State.clientes[index] = {
      ...State.clientes[index],
      ...cliente,
    };
    return;
  }

  State.clientes = [cliente, ...State.clientes];
}

function renderClienteDashboardLoading() {
  const content = document.getElementById("clienteDashboardContent");
  if (!content) return;

  content.innerHTML = `
    <div class="cliente-dashboard-loading">
      <i class="fa-solid fa-spinner fa-spin"></i>
      <p style="margin:10px 0 0;">Carregando histórico do cliente...</p>
    </div>
  `;
}

function renderClienteDashboardError(message) {
  const content = document.getElementById("clienteDashboardContent");
  if (!content) return;

  content.innerHTML = `
    <div class="cliente-dashboard-error">
      <i class="fa-solid fa-circle-exclamation"></i>
      <p style="margin:10px 0 0;">${escHtml(message || "Não foi possível carregar o painel do cliente.")}</p>
    </div>
  `;
}

function handleClienteDashboardBackdrop(event) {
  if (event.target === event.currentTarget) {
    fecharClienteDashboard();
  }
}

function fecharClienteDashboard() {
  const drawer = document.getElementById("clienteDashboardDrawer");
  if (drawer) {
    drawer.classList.remove("open");
  }

  State.currentClienteDashboardId = null;
  State.currentClienteDashboard = null;
  updateBodyOverflow();
}

async function abrirClienteDashboard(id) {
  const clienteId = Number(id);
  if (!clienteId) return;

  const drawer = document.getElementById("clienteDashboardDrawer");
  if (!drawer) return;

  State.currentClienteDashboardId = clienteId;
  drawer.classList.add("open");
  renderClienteDashboardLoading();
  updateBodyOverflow();

  await loadClienteDashboard(clienteId);
}

async function loadClienteDashboard(id, options = {}) {
  const clienteId = Number(id);
  const silent = Boolean(options?.silent);
  if (!clienteId) return;

  if (!silent) {
    renderClienteDashboardLoading();
  }

  try {
    const res = await fetch(`/api/cobrancas/clientes/${clienteId}/dashboard`);
    const data = await res.json();

    if (Number(State.currentClienteDashboardId) !== clienteId) {
      return;
    }

    if (!data.ok || !data.dashboard) {
      if (res.status === 404) {
        fecharClienteDashboard();
      } else if (!silent) {
        renderClienteDashboardError(data.error || "Erro ao carregar painel do cliente.");
        showToast("error", data.error || "Erro ao carregar painel do cliente");
      }
      return;
    }

    State.currentClienteDashboard = data.dashboard;
    syncClienteDashboardCache(data.dashboard.cliente);
    renderClienteDashboard(data.dashboard);
  } catch (err) {
    console.error(err);

    if (!silent) {
      renderClienteDashboardError("Erro de conexão ao carregar o cliente.");
      showToast("error", "Erro ao carregar painel do cliente");
    }
  }
}

function refreshOpenClienteDashboard() {
  if (!State.currentClienteDashboardId) {
    return Promise.resolve();
  }

  return loadClienteDashboard(State.currentClienteDashboardId, { silent: true });
}

function refreshOpenMpCheckoutModal() {
  const modal = document.getElementById("modalMpCheckout");
  if (!modal?.classList.contains("open") || !State.currentMpCheckoutChargeId) {
    return Promise.resolve();
  }

  const charge = findChargeById(State.currentMpCheckoutChargeId);
  if (!charge) {
    return Promise.resolve();
  }

  if (charge.mp_checkout_url) {
    renderMpCheckoutActiveState(charge);
    return Promise.resolve();
  }

  if (canOpenMpCheckout(charge)) {
    renderMpCheckoutCreateState(charge);
  }

  return Promise.resolve();
}

function abrirNovaCobrancaDoDrawer() {
  const cliente = State.currentClienteDashboard?.cliente;
  if (!cliente) {
    abrirModalNovaCobranca();
    return;
  }

  limparFormCobranca();
  document.getElementById("cbClienteId").value = String(Number(cliente.id) || "");
  document.getElementById("cbNome").value = cliente.nome || "";
  setPhoneInputValue("cbTelefone", cliente.telefone || "");
  document.getElementById("cbEmail").value = cliente.email || "";
  document.getElementById("cbCpfCnpj").value = cliente.cpf_cnpj || "";
  abrirModal("modalNovaCobranca");
}

function buildClienteDashboardChargeCards(cobrancas) {
  if (!Array.isArray(cobrancas) || !cobrancas.length) {
    return `<div class="cliente-dashboard-empty">Esse cliente ainda não possui cobranças registradas.</div>`;
  }

  return cobrancas
    .map((cobranca) => {
      const valorRecebido = Number(cobranca.valor_pago || 0);
      const saldoAberto = getChargeRemainingValue(cobranca);
      const isParcelado =
        Number(cobranca.parcelas || 1) > 1 && Number(cobranca.parcela_atual || 0) > 0;

      return `
        <article class="cliente-history-card">
          <div class="cliente-history-top">
            <div class="cliente-history-main">
              <strong>${escHtml(cobranca.descricao || "Cobrança sem descrição")}</strong>
              <div class="cliente-history-subinfo">
                ${escHtml(formatBillingTypeText(cobranca.billing_type))} • vencimento em ${escHtml(formatDate(cobranca.vencimento))}
              </div>
            </div>
            <div class="cliente-history-value">
              <strong>${formatCurrency(cobranca.valor)}</strong>
              <span>${valorRecebido > 0 ? `${formatCurrency(valorRecebido)} recebido` : "Sem recebimentos"}</span>
            </div>
          </div>

          <div class="cliente-history-meta">
            <span class="badge-status badge-${cobranca.status}">${formatStatus(cobranca.status)}</span>
            ${saldoAberto > 0 ? `<span class="cliente-chip">${escHtml(formatCurrency(saldoAberto))} em aberto</span>` : ""}
            ${isParcelado ? `<span class="cliente-chip">${Number(cobranca.parcela_atual)}/${Number(cobranca.parcelas)}x</span>` : ""}
            ${cobranca.recorrente ? `<span class="cliente-chip"><i class="fa-solid fa-rotate"></i> Recorrente</span>` : ""}
          </div>

          <div class="cliente-history-actions">
            <button type="button" class="cliente-inline-action" onclick="abrirDetalhes(${Number(cobranca.id)})">
              Ver detalhes
            </button>
            ${canRegisterChargeReceipt(cobranca)
              ? `
                <button
                  type="button"
                  class="cliente-inline-action primary"
                  onclick="abrirModalPagar(${Number(cobranca.id)})"
                >
                  ${cobranca.status === "PARCIAL" ? "Adicionar recebimento" : "Registrar pagamento"}
                </button>
              `
              : ""}
          </div>
        </article>
      `;
    })
    .join("");
}

function buildClienteDashboardRecorrenciaCards(recorrencias) {
  if (!Array.isArray(recorrencias) || !recorrencias.length) {
    return `<div class="cliente-dashboard-empty">Nenhuma recorrência ativa para esse cliente.</div>`;
  }

  return recorrencias
    .map((recorrencia) => `
      <article class="cliente-history-card">
        <div class="cliente-history-top">
          <div class="cliente-history-main">
            <strong>${escHtml(recorrencia.descricao || "Recorrência sem descrição")}</strong>
            <div class="cliente-history-subinfo">
              ${escHtml(formatCycle(recorrencia.cycle))} • próxima cobrança em ${escHtml(formatDate(recorrencia.proxima_cobranca))}
            </div>
          </div>
          <div class="cliente-history-value">
            <strong>${formatCurrency(recorrencia.valor)}</strong>
            <span>${escHtml(formatBillingTypeText(recorrencia.billing_type))}</span>
          </div>
        </div>
      </article>
    `)
    .join("");
}

function renderClienteDashboard(dashboard) {
  const content = document.getElementById("clienteDashboardContent");
  if (!content || !dashboard?.cliente) return;

  const cliente = dashboard.cliente;
  const resumo = dashboard.resumo || {};
  const cobrancas = Array.isArray(dashboard.cobrancas) ? dashboard.cobrancas : [];
  const recorrencias = Array.isArray(dashboard.recorrencias) ? dashboard.recorrencias : [];
  const observacoes = String(cliente.observacoes || "").trim();
  const chips = [
    cliente.telefone
      ? `<span class="cliente-chip"><i class="fa-brands fa-whatsapp"></i> ${escHtml(formatPhoneDisplay(cliente.telefone))}</span>`
      : "",
    cliente.email
      ? `<span class="cliente-chip"><i class="fa-solid fa-envelope"></i> ${escHtml(cliente.email)}</span>`
      : "",
    cliente.cpf_cnpj
      ? `<span class="cliente-chip"><i class="fa-regular fa-id-card"></i> ${escHtml(cliente.cpf_cnpj)}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  content.innerHTML = `
    <section class="cliente-dashboard-hero">
      <div class="cliente-dashboard-title-row">
        <div class="cliente-dashboard-identity">
          <h3>${escHtml(cliente.nome)}</h3>
          <p>${escHtml(
            observacoes || "Histórico completo do cliente, cobranças abertas e recorrências ativas em um só lugar."
          )}</p>
        </div>
        <div class="cliente-dashboard-actions">
          <button type="button" class="btn-primary-cob" onclick="abrirNovaCobrancaDoDrawer()">
            <i class="fa-solid fa-plus"></i> Nova cobrança
          </button>
          <button type="button" class="btn-ghost-cob" onclick="fecharClienteDashboard();switchTab('clientes')">
            <i class="fa-solid fa-address-book"></i> Ver clientes
          </button>
        </div>
      </div>

      <div class="cliente-dashboard-meta">${chips || '<span class="cliente-chip"><i class="fa-solid fa-user"></i> Cliente sem dados extras cadastrados</span>'}</div>

      <div class="cliente-dashboard-summary-grid">
        <div class="cliente-dashboard-summary-card is-success">
          <label>Total recebido</label>
          <strong>${formatCurrency(resumo.total_recebido || 0)}</strong>
          <span>${Number(resumo.total_cobrancas || cobrancas.length)} cobrança(s) no histórico</span>
        </div>
        <div class="cliente-dashboard-summary-card is-warning">
          <label>Total em aberto</label>
          <strong>${formatCurrency(resumo.total_em_aberto || 0)}</strong>
          <span>${Number(resumo.cobrancas_abertas || 0)} cobrança(s) aberta(s)</span>
        </div>
        <div class="cliente-dashboard-summary-card is-danger">
          <label>Em atraso</label>
          <strong>${formatCurrency(resumo.total_vencido || 0)}</strong>
          <span>Saldo vencido desse cliente</span>
        </div>
        <div class="cliente-dashboard-summary-card">
          <label>Recorrências ativas</label>
          <strong>${Number(resumo.recorrencias_ativas || recorrencias.length).toLocaleString("pt-BR")}</strong>
          <span>${recorrencias.length ? "Cobranças futuras já programadas" : "Sem assinaturas em andamento"}</span>
        </div>
      </div>
    </section>

    <div class="cliente-dashboard-sections">
      <section class="cliente-dashboard-section">
        <div class="cliente-dashboard-section-head">
          <h4>Todas as cobranças</h4>
          <span>${Number(cobrancas.length).toLocaleString("pt-BR")} registro(s)</span>
        </div>
        <div class="cliente-dashboard-list">
          ${buildClienteDashboardChargeCards(cobrancas)}
        </div>
      </section>

      <section class="cliente-dashboard-section">
        <div class="cliente-dashboard-section-head">
          <h4>Recorrências ativas</h4>
          <span>${Number(recorrencias.length).toLocaleString("pt-BR")} ativa(s)</span>
        </div>
        <div class="cliente-dashboard-list">
          ${buildClienteDashboardRecorrenciaCards(recorrencias)}
        </div>
      </section>
    </div>
  `;
}
