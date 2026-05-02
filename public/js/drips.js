(function () {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const DEFAULT_STAGES = [
    "Novo",
    "Qualificando",
    "Negociacao",
    "Fechado",
    "Perdido",
  ];
  const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

  const bootstrap = window.__DRIP_BOOTSTRAP__ || {};

  const refs = {
    planName: document.getElementById("plan-name"),
    usagePill: document.getElementById("usage-pill"),
    sessionsPill: document.getElementById("sessions-pill"),
    usageCounter: document.getElementById("usage-counter"),
    usagePercent: document.getElementById("usage-percent"),
    usageBar: document.getElementById("usage-bar"),
    usageFoot: document.getElementById("usage-foot"),
    usageActiveCampaigns: document.getElementById("usage-active-campaigns"),
    usageConnectedSessions: document.getElementById("usage-connected-sessions"),
    usageLimitLabel: document.getElementById("usage-limit-label"),
    upgradeBanner: document.getElementById("upgrade-banner"),
    createNewBtn: document.getElementById("create-new-btn"),
    reloadBtn: document.getElementById("reload-btn"),
    heroSelectedCampaign: document.getElementById("hero-selected-campaign"),
    heroSelectedFoot: document.getElementById("hero-selected-foot"),
    heroWindowTotal: document.getElementById("hero-window-total"),
    heroWindowFoot: document.getElementById("hero-window-foot"),
    heroActiveEnrollments: document.getElementById("hero-active-enrollments"),
    heroEnrollmentFoot: document.getElementById("hero-enrollment-foot"),
    statCampaigns: document.getElementById("stat-campaigns"),
    statCampaignsFoot: document.getElementById("stat-campaigns-foot"),
    statActiveEnrollments: document.getElementById("stat-active-enrollments"),
    statActiveFoot: document.getElementById("stat-active-foot"),
    statCompleted: document.getElementById("stat-completed"),
    statCompletedFoot: document.getElementById("stat-completed-foot"),
    statFailed: document.getElementById("stat-failed"),
    statFailedFoot: document.getElementById("stat-failed-foot"),
    editorBadge: document.getElementById("editor-badge"),
    editorStatus: document.getElementById("editor-status"),
    editorOverview: document.getElementById("editor-overview"),
    editorConfigBtn: document.getElementById("editor-config-btn"),
    editorConfigAnchor: document.getElementById("editor-config-anchor"),
    campaignName: document.getElementById("campaign-name"),
    triggerStage: document.getElementById("trigger-stage"),
    preferredSession: document.getElementById("preferred-session"),
    campaignActive: document.getElementById("campaign-active"),
    campaignActiveLabel: document.getElementById("campaign-active-label"),
    campaignActiveCopy: document.getElementById("campaign-active-copy"),
    campaignActiveShell: document.getElementById("campaign-active-shell"),
    addStepBtn: document.getElementById("add-step-btn"),
    timelineAddStepBtn: document.getElementById("timeline-add-step"),
    stepsContainer: document.getElementById("steps-container"),
    saveBtn: document.getElementById("save-btn"),
    deleteBtn: document.getElementById("delete-btn"),
    selectionSummary: document.getElementById("selection-summary"),
    selectionHealth: document.getElementById("selection-health"),
    campaignList: document.getElementById("campaign-list"),
    metricsGrid: document.getElementById("metrics-grid"),
    timelinePreview: document.getElementById("timeline-preview"),
    enrollmentSummary: document.getElementById("enrollment-summary"),
    enrollmentList: document.getElementById("enrollment-list"),
  };

  const buttonMarkup = {
    reload: refs.reloadBtn ? refs.reloadBtn.innerHTML : "",
    save: refs.saveBtn ? refs.saveBtn.innerHTML : "",
    delete: refs.deleteBtn ? refs.deleteBtn.innerHTML : "",
  };

  const state = {
    campaigns: [],
    access: bootstrap.access || {
      plan: "free",
      maxMonthlyEnrollments: 500,
      monthlyEnrollmentsUsed: 0,
      monthlyEnrollmentsRemaining: 500,
    },
    stages:
      Array.isArray(bootstrap.stages) && bootstrap.stages.length
        ? bootstrap.stages
        : DEFAULT_STAGES,
    sessions: Array.isArray(bootstrap.sessions) ? bootstrap.sessions : [],
    selectedCampaignId: null,
    editor: null,
    enrollments: [],
    loadingCampaigns: false,
    loadingEnrollments: false,
    saving: false,
    deleting: false,
    preferBlankEditor: false,
  };

  function showMessage(type, message) {
    if (typeof window.showToast === "function") {
      window.showToast(type, message);
      return;
    }

    if (type === "error") {
      alert(message);
      return;
    }

    console.log(message);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function formatCompactNumber(value) {
    return new Intl.NumberFormat("pt-BR").format(Math.max(0, toNumber(value, 0)));
  }

  function formatCount(value, singular, plural) {
    const numeric = Math.max(0, toNumber(value, 0));
    return `${formatCompactNumber(numeric)} ${numeric === 1 ? singular : plural}`;
  }

  function createEmptyState(message) {
    return `<div class="empty-state">${escapeHtml(message)}</div>`;
  }

  function getDefaultStage() {
    return state.stages.includes("Qualificando")
      ? "Qualificando"
      : state.stages[0] || DEFAULT_STAGES[0];
  }

  function createBlankStep(stepOrder, delayMs) {
    return {
      id: null,
      stepOrder,
      delayMs: Math.max(0, toNumber(delayMs, stepOrder === 0 ? 0 : DAY_MS)),
      message: "",
      file: null,
      filename: null,
    };
  }

  function createBlankCampaign() {
    return {
      id: null,
      name: "",
      triggerStage: getDefaultStage(),
      preferredSession: "",
      active: true,
      steps: [createBlankStep(0, 0)],
      stats: {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        active: 0,
      },
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function renumberSteps(steps) {
    return (steps || []).map((step, index) => ({
      ...step,
      stepOrder: index,
    }));
  }

  function cloneCampaignForEditor(campaign) {
    if (!campaign) return createBlankCampaign();

    return {
      id: campaign.id,
      name: String(campaign.name || ""),
      triggerStage: String(campaign.triggerStage || getDefaultStage()),
      preferredSession: campaign.preferredSession || "",
      active: Boolean(campaign.active),
      steps: renumberSteps(
        (campaign.steps || []).map((step, index) => ({
          id: step.id || null,
          stepOrder: index,
          delayMs: Math.max(0, toNumber(step.delayMs, 0)),
          message: String(step.message || ""),
          file: step.file || null,
          filename: step.filename || null,
        }))
      ),
      stats: campaign.stats || {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        active: 0,
      },
      createdAt: toNumber(campaign.createdAt, 0),
      updatedAt: toNumber(campaign.updatedAt, 0),
    };
  }

  function getSelectedCampaign() {
    return (
      state.campaigns.find(
        (campaign) => Number(campaign.id) === Number(state.selectedCampaignId)
      ) || null
    );
  }

  function getEditorFocusCampaign() {
    const editor = state.editor || createBlankCampaign();
    const selected = getSelectedCampaign();

    if (!selected) return editor;

    return {
      ...selected,
      ...editor,
      stats: selected.stats || editor.stats,
      createdAt: toNumber(selected.createdAt, 0),
      updatedAt: toNumber(selected.updatedAt, 0),
    };
  }

  function splitDelayMs(delayMs) {
    const safeDelay = Math.max(0, toNumber(delayMs, 0));

    if (safeDelay === 0) {
      return { value: 0, unit: "minutes" };
    }
    if (safeDelay % DAY_MS === 0) {
      return { value: safeDelay / DAY_MS, unit: "days" };
    }
    if (safeDelay % HOUR_MS === 0) {
      return { value: safeDelay / HOUR_MS, unit: "hours" };
    }
    return {
      value: Math.max(1, Math.round(safeDelay / MINUTE_MS)),
      unit: "minutes",
    };
  }

  function joinDelayMs(value, unit) {
    const safeValue = Math.max(0, Math.trunc(toNumber(value, 0)));
    if (unit === "days") return safeValue * DAY_MS;
    if (unit === "hours") return safeValue * HOUR_MS;
    return safeValue * MINUTE_MS;
  }

  function formatDuration(ms) {
    const safeMs = Math.max(0, toNumber(ms, 0));
    if (safeMs <= 0) return "agora";

    let remaining = Math.round(safeMs / MINUTE_MS);
    const days = Math.floor(remaining / (24 * 60));
    remaining -= days * 24 * 60;
    const hours = Math.floor(remaining / 60);
    remaining -= hours * 60;
    const minutes = remaining;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}min`);

    return parts.join(" ");
  }

  function formatDelayBadge(ms) {
    return ms > 0 ? formatDuration(ms) : "Imediato";
  }

  function formatRelativeDelay(ms) {
    return ms > 0 ? `apos ${formatDuration(ms)}` : "imediatamente";
  }

  function formatDateTime(timestamp) {
    const safeTs = toNumber(timestamp, 0);
    if (!safeTs) return "Sem agendamento";

    const date = new Date(safeTs);
    if (Number.isNaN(date.getTime())) return "Sem agendamento";

    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) return "--";
    if (digits.length <= 2) return `+${digits}`;
    return `+${digits.slice(0, 2)} ${digits.slice(2)}`;
  }

  function getStatusConfig(status, activeFlag) {
    if (status === "completed") {
      return { className: "completed", label: "Concluida" };
    }
    if (status === "processing") {
      return { className: "processing", label: "Processando" };
    }
    if (status === "failed") {
      return { className: "failed", label: "Falhou" };
    }
    if (status === "cancelled") {
      return { className: "cancelled", label: "Cancelada" };
    }
    if (status === "pending") {
      return { className: "pending", label: "Pendente" };
    }
    if (status === "inactive" || activeFlag === false) {
      return { className: "inactive", label: "Pausada" };
    }
    if (status === "active") {
      return { className: "active", label: "Ativa" };
    }
    return { className: "active", label: "Ativa" };
  }

  function getCampaignSnippet(campaign) {
    const firstMessage = (campaign.steps || []).find((step) =>
      String(step.message || "").trim()
    );
    if (firstMessage) {
      return String(firstMessage.message || "").trim().slice(0, 110);
    }

    const firstFile = (campaign.steps || []).find((step) => step.filename);
    if (firstFile) {
      return `Primeiro passo envia: ${String(firstFile.filename || "arquivo")}`;
    }

    return "Sequencia sem preview disponivel.";
  }

  function getStepTitle(step, index) {
    const rawMessage = String(step.message || "").trim().replace(/\s+/g, " ");
    const lead =
      rawMessage ||
      (step.filename ? `Arquivo ${String(step.filename || "").trim()}` : `Passo ${index + 1}`);
    const clipped = lead.length > 30 ? `${lead.slice(0, 30).trim()}...` : lead;
    return `${formatDelayBadge(step.delayMs)} - ${clipped}`;
  }

  function getStepDelayCopy(step, index) {
    return index === 0
      ? "Enviado assim que o lead entra na campanha."
      : `Dispara ${formatRelativeDelay(step.delayMs)} do passo anterior.`;
  }

  function getStepPreview(step) {
    const message = String(step.message || "").trim().replace(/\s+/g, " ");
    if (message) {
      return message.length > 180 ? `${message.slice(0, 180).trim()}...` : message;
    }

    if (step.filename) {
      return `Sem texto adicional. O passo envia o arquivo ${String(step.filename || "arquivo")}.`;
    }

    return "Sem conteudo definido para este passo.";
  }

  function getSessionModeLabel(sessionName) {
    return sessionName ? String(sessionName) : "Automatica";
  }

  function getConnectedSessionsCount() {
    return state.sessions.filter(
      (session) => String(session.status || "").toLowerCase() === "connected"
    ).length;
  }

  function getCampaignTotals() {
    return state.campaigns.reduce(
      (acc, campaign) => {
        const stats = campaign.stats || {};
        acc.active += toNumber(stats.active, 0);
        acc.completed += toNumber(stats.completed, 0);
        acc.failed += toNumber(stats.failed, 0);
        acc.pending += toNumber(stats.pending, 0);
        acc.processing += toNumber(stats.processing, 0);
        return acc;
      },
      { active: 0, completed: 0, failed: 0, pending: 0, processing: 0 }
    );
  }

  function getCampaignInsights(campaign) {
    const safeCampaign = campaign || createBlankCampaign();
    const steps = Array.isArray(safeCampaign.steps) ? safeCampaign.steps : [];
    const totalDelay = steps.reduce(
      (acc, step) => acc + Math.max(0, toNumber(step.delayMs, 0)),
      0
    );
    const mediaSteps = steps.filter((step) => step.filename || step.file).length;
    const textSteps = steps.filter((step) => String(step.message || "").trim()).length;
    const immediateSteps = steps.filter((step) => toNumber(step.delayMs, 0) <= 0).length;
    const delayedSteps = Math.max(0, steps.length - immediateSteps);

    return {
      steps,
      totalDelay,
      mediaSteps,
      textSteps,
      immediateSteps,
      delayedSteps,
      triggerStage: safeCampaign.triggerStage || getDefaultStage(),
      preferredSession: safeCampaign.preferredSession || "",
      snippet: getCampaignSnippet(safeCampaign),
      stats: safeCampaign.stats || {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        active: 0,
      },
      createdAt: toNumber(safeCampaign.createdAt, 0),
      updatedAt: toNumber(safeCampaign.updatedAt, 0),
    };
  }

  function getUsageState() {
    const access = state.access || {};
    const used = Math.max(0, toNumber(access.monthlyEnrollmentsUsed, 0));
    const limit = access.maxMonthlyEnrollments;

    if (limit === "unlimited") {
      return {
        counter: `${formatCompactNumber(used)} usados`,
        percent: "PRO",
        pct: Math.min(100, Math.max(24, Math.round(Math.log10(used + 10) * 22))),
        className: "is-pro",
        pillText: "Sem teto mensal",
        foot: "Plano Pro sem teto mensal de enrollments ativos.",
        limitLabel: "Ilimitado",
        showUpgrade: false,
      };
    }

    const numericLimit = Math.max(1, toNumber(limit, 1));
    const remaining = Math.max(0, toNumber(access.monthlyEnrollmentsRemaining, 0));
    const pct = Math.min(100, Math.round((used / numericLimit) * 100));
    const className = pct >= 90 ? "is-alert" : pct >= 65 ? "is-warn" : "is-good";

    return {
      counter: `${formatCompactNumber(used)}/${formatCompactNumber(numericLimit)}`,
      percent: `${pct}%`,
      pct,
      className,
      pillText: remaining
        ? `${formatCompactNumber(remaining)} restantes`
        : "Limite atingido",
      foot: `${formatCompactNumber(remaining)} restante(s) neste mes antes do limite do plano.`,
      limitLabel: `${formatCompactNumber(numericLimit)}/mes`,
      showUpgrade: true,
    };
  }

  function syncButtonStates() {
    refs.reloadBtn.disabled = state.loadingCampaigns;
    refs.reloadBtn.innerHTML = state.loadingCampaigns
      ? '<span class="loading-content"><span class="spinner-inline"></span><span class="loading-label">Atualizando</span></span>'
      : buttonMarkup.reload;

    refs.saveBtn.disabled = state.saving;
    refs.saveBtn.innerHTML = state.saving
      ? '<span class="loading-content"><span class="spinner-inline"></span><span class="loading-label">Salvando</span></span>'
      : buttonMarkup.save;

    refs.deleteBtn.disabled = !state.editor?.id || state.deleting;
    refs.deleteBtn.innerHTML = state.deleting
      ? '<span class="loading-content"><span class="spinner-inline"></span><span class="loading-label">Excluindo</span></span>'
      : buttonMarkup.delete;
  }

  function renderAccessCard() {
    const usage = getUsageState();
    const connectedSessions = getConnectedSessionsCount();
    const activeCampaigns = state.campaigns.filter((campaign) => campaign.active).length;

    refs.planName.textContent = String(state.access.plan || "free").toUpperCase();
    refs.usageCounter.textContent = usage.counter;
    refs.usagePercent.textContent = usage.percent;
    refs.usageFoot.textContent = usage.foot;
    refs.usageActiveCampaigns.textContent = formatCompactNumber(activeCampaigns);
    refs.usageConnectedSessions.textContent = formatCompactNumber(connectedSessions);
    refs.usageLimitLabel.textContent = usage.limitLabel;

    refs.usageBar.style.width = `${usage.pct}%`;
    refs.usageBar.className = `usage-bar ${usage.className}`;

    refs.usagePill.className = `status-pill ${usage.className}`;
    refs.usagePill.textContent = usage.pillText;

    refs.sessionsPill.className = `status-pill ${
      connectedSessions > 0 ? "is-good" : "is-alert"
    }`;
    refs.sessionsPill.textContent =
      connectedSessions > 0
        ? `${formatCount(connectedSessions, "sessao conectada", "sessoes conectadas")}`
        : "Sem sessao conectada";

    refs.upgradeBanner.classList.toggle("hidden", !usage.showUpgrade);
  }

  function renderHeroHighlights() {
    const selected = getSelectedCampaign();
    const focus = getEditorFocusCampaign();
    const insights = getCampaignInsights(focus);
    const totals = getCampaignTotals();
    const status = selected
      ? getStatusConfig(focus.active ? "active" : "inactive")
      : state.editor?.name
        ? { label: "Rascunho" }
        : { label: "Nova campanha" };

    refs.heroSelectedCampaign.textContent =
      String(focus.name || "").trim() || "Nova campanha";
    refs.heroSelectedFoot.textContent = selected
      ? `${focus.triggerStage} • ${formatCount(
          insights.steps.length,
          "passo",
          "passos"
        )} • ${status.label}`
      : `${insights.triggerStage} • ${formatCount(
          insights.steps.length,
          "passo no editor",
          "passos no editor"
        )}`;

    refs.heroWindowTotal.textContent = formatDelayBadge(insights.totalDelay);
    refs.heroWindowFoot.textContent = insights.steps.length
      ? `${formatCount(insights.immediateSteps, "passo imediato", "passos imediatos")} e ${formatCount(
          insights.delayedSteps,
          "passo com espera",
          "passos com espera"
        )}.`
      : "Tempo ate o ultimo passo do editor.";

    refs.heroActiveEnrollments.textContent = formatCompactNumber(totals.active);
    refs.heroEnrollmentFoot.textContent = totals.active
      ? `${formatCount(totals.pending, "pendente", "pendentes")} e ${formatCount(
          totals.processing,
          "em processamento",
          "em processamento"
        )}.`
      : "Sem leads em andamento.";
  }

  function renderStats() {
    const totalCampaigns = state.campaigns.length;
    const activeCampaigns = state.campaigns.filter((campaign) => campaign.active).length;
    const totals = getCampaignTotals();

    refs.statCampaigns.textContent = formatCompactNumber(totalCampaigns);
    refs.statCampaignsFoot.textContent = totalCampaigns
      ? `${formatCount(activeCampaigns, "campanha ativa", "campanhas ativas")} no momento`
      : "Nenhum funil criado ainda";

    refs.statActiveEnrollments.textContent = formatCompactNumber(totals.active);
    refs.statActiveFoot.textContent = totals.active
      ? `${formatCount(totals.pending, "pendente", "pendentes")} e ${formatCount(
          totals.processing,
          "processando",
          "processando"
        )}`
      : "Sem leads em andamento";

    refs.statCompleted.textContent = formatCompactNumber(totals.completed);
    refs.statCompletedFoot.textContent = totals.completed
      ? "Fluxos finalizaram todos os passos."
      : "Sem historico concluido";

    refs.statFailed.textContent = formatCompactNumber(totals.failed);
    refs.statFailedFoot.textContent = totals.failed
      ? "Revise sessoes, midias ou mensagens."
      : "Nenhuma falha relevante";
  }

  function renderStageOptions() {
    const current = state.editor?.triggerStage || getDefaultStage();
    refs.triggerStage.innerHTML = state.stages
      .map(
        (stage) =>
          `<option value="${escapeHtml(stage)}">${escapeHtml(stage)}</option>`
      )
      .join("");

    refs.triggerStage.value = state.stages.includes(current)
      ? current
      : getDefaultStage();
  }

  function renderSessionOptions() {
    const current = state.editor?.preferredSession || "";
    const options = [
      `<option value="">Automatica (primeira sessao conectada)</option>`,
      ...state.sessions.map((session) => {
        const name = String(session.session_name || "");
        const status = String(session.status || "unknown");
        return `<option value="${escapeHtml(name)}">${escapeHtml(
          `${name} (${status})`
        )}</option>`;
      }),
    ];

    refs.preferredSession.innerHTML = options.join("");
    refs.preferredSession.value = current;
  }

  function renderEditorHeader() {
    const current = state.editor || createBlankCampaign();
    const isActive = current.active !== false;
    const selected = getSelectedCampaign();
    const stats = selected?.stats || current.stats || {};
    const activeLeads = Math.max(0, toNumber(stats.active, 0));
    let badgeClass = "active";
    let badgeText = "Ativa";

    if (!current.id && String(current.name || "").trim()) {
      badgeClass = "pending";
      badgeText = "Rascunho";
    } else if (!current.id) {
      badgeClass = "pending";
      badgeText = "Nova campanha";
    } else if (!isActive) {
      badgeClass = "inactive";
      badgeText = "Pausada";
    }

    refs.editorBadge.className = `status-pill editor-badge-pill ${badgeClass}`;
    refs.editorBadge.textContent =
      current.id && badgeClass !== "pending"
        ? `${badgeText} | ${formatCount(activeLeads, "lead", "leads")}`
        : badgeText;
    refs.campaignName.value = current.name || "";
    renderStageOptions();
    renderSessionOptions();

    refs.campaignActive.checked = isActive;
    refs.campaignActiveLabel.textContent = isActive
      ? "Campanha ativa"
      : "Campanha pausada";
    refs.campaignActiveCopy.textContent = isActive
      ? "Leads que entrarem no gatilho serao inscritos automaticamente."
      : "Novos leads nao entram no funil ate voce reativar a campanha.";
    refs.campaignActiveShell.classList.toggle("is-active", isActive);
    refs.campaignActiveShell.classList.toggle("is-inactive", !isActive);

    updateEditorStatusMessage();
    syncButtonStates();
  }

  function updateEditorStatusMessage() {
    const selected = getSelectedCampaign();
    const focus = getEditorFocusCampaign();

    if (selected) {
      refs.editorStatus.textContent = `${formatCount(
        focus.steps?.length || 0,
        "passo",
        "passos"
      )}, trigger em ${focus.triggerStage} e ${formatCount(
        selected.stats.active || 0,
        "enrollment ativo",
        "enrollments ativos"
      )}.`;
    } else {
      refs.editorStatus.textContent =
        "Pronto para criar uma nova automacao e ligar o funil ao CRM.";
    }
  }

  function renderEditorOverview() {
    const insights = getCampaignInsights(state.editor || createBlankCampaign());
    refs.editorOverview.innerHTML = `
      <article class="overview-card">
        <span>Passos</span>
        <strong>${formatCompactNumber(insights.steps.length)}</strong>
      </article>
      <article class="overview-card">
        <span>Janela total</span>
        <strong>${formatDelayBadge(insights.totalDelay)}</strong>
      </article>
      <article class="overview-card">
        <span>Passos com midia</span>
        <strong>${formatCompactNumber(insights.mediaSteps)}</strong>
      </article>
      <article class="overview-card">
        <span>Entrada no funil</span>
        <strong>${escapeHtml(insights.triggerStage)}</strong>
      </article>
    `;
  }

  function renderSteps() {
    const steps = state.editor?.steps || [];

    if (!steps.length) {
      refs.stepsContainer.innerHTML = createEmptyState(
        "Adicione pelo menos um passo para montar a automacao."
      );
      return;
    }

    refs.stepsContainer.innerHTML = steps
      .map((step, index) => {
        const delay = splitDelayMs(step.delayMs);
        const canRemove = steps.length > 1;
        const messageLength = String(step.message || "").trim().length;
        const stepTitle = getStepTitle(step, index);
        const stepDelayCopy = getStepDelayCopy(step, index);
        const stepPreview = getStepPreview(step);
        const mediaChip = step.filename
          ? `
            <span class="media-chip">
              <i class="fa-solid fa-paperclip"></i>
              ${escapeHtml(step.filename)}
              <button type="button" data-action="remove-file" aria-label="Remover arquivo">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </span>
          `
          : "";

        return `
          <article class="step-card" data-step-index="${index}">
            <div class="step-card-top">
              <span class="step-order">${String(index + 1).padStart(2, "0")}</span>
              <div class="step-header-copy">
                <h3 data-role="step-title">${escapeHtml(stepTitle)}</h3>
                <div class="step-meta" data-role="delay-copy">${escapeHtml(stepDelayCopy)}</div>
              </div>
              <span class="step-badge" data-role="delay-badge">${formatDelayBadge(
                step.delayMs
              )}</span>
            </div>

            <div class="step-summary">
              <span class="inline-chip"><i class="fa-regular fa-message"></i>${formatCount(
                messageLength,
                "caractere",
                "caracteres"
              )}</span>
              <span class="inline-chip"><i class="fa-solid fa-paperclip"></i>${
                step.filename ? "Com anexo" : "Somente texto"
              }</span>
            </div>

            <div class="step-preview" data-role="step-preview">${escapeHtml(stepPreview)}</div>

            <div class="step-fields">
              <div class="field">
                <span>Atraso do passo</span>
                <div class="step-delay-wrap">
                  <input
                    class="step-delay-value"
                    data-field="delay-value"
                    type="number"
                    min="0"
                    step="1"
                    value="${delay.value}"
                  />
                  <select class="step-delay-unit" data-field="delay-unit">
                    <option value="minutes" ${
                      delay.unit === "minutes" ? "selected" : ""
                    }>Minutos</option>
                    <option value="hours" ${
                      delay.unit === "hours" ? "selected" : ""
                    }>Horas</option>
                    <option value="days" ${
                      delay.unit === "days" ? "selected" : ""
                    }>Dias</option>
                  </select>
                </div>
              </div>

              <label class="field">
                <span>Mensagem</span>
                <textarea
                  class="step-message"
                  data-field="message"
                  placeholder="Escreva a mensagem deste passo..."
                >${escapeHtml(step.message || "")}</textarea>
                <small class="helper-text" data-role="message-count">${formatCount(
                  messageLength,
                  "caractere",
                  "caracteres"
                )}</small>
              </label>
            </div>

            <div class="step-footer">
              <div class="step-media">
                <button type="button" class="btn btn-ghost" data-action="pick-file">
                  <i class="fa-solid fa-paperclip"></i>
                  ${step.filename ? "Trocar arquivo" : "Anexar arquivo"}
                </button>
                <input
                  class="hidden"
                  data-field="file-input"
                  type="file"
                  accept="image/*,video/*,audio/*,.pdf,.txt,.csv,.zip,.xls,.xlsx,.doc,.docx"
                />
                ${mediaChip}
              </div>

              <button type="button" class="btn btn-ghost" data-action="remove-step" ${
                canRemove ? "" : "disabled"
              }>
                <i class="fa-solid fa-trash"></i>
                Remover passo
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderMetrics() {
    const insights = getCampaignInsights(state.editor || createBlankCampaign());
    const sessionLabel = getSessionModeLabel(insights.preferredSession);
    const firstTouch =
      insights.steps[0] && toNumber(insights.steps[0].delayMs, 0) > 0
        ? formatRelativeDelay(insights.steps[0].delayMs)
        : "imediatamente";

    refs.metricsGrid.innerHTML = `
      <article class="metric-card">
        <strong>Passos</strong>
        <span class="metric-value">${formatCompactNumber(insights.steps.length)}</span>
        <span class="metric-foot">Cada lead avanca um passo por vez.</span>
      </article>
      <article class="metric-card">
        <strong>Janela total</strong>
        <span class="metric-value">${formatDelayBadge(insights.totalDelay)}</span>
        <span class="metric-foot">Tempo aproximado ate o ultimo envio.</span>
      </article>
      <article class="metric-card">
        <strong>Primeiro toque</strong>
        <span class="metric-value">${escapeHtml(firstTouch)}</span>
        <span class="metric-foot">Momento em que o contato recebe a primeira acao.</span>
      </article>
      <article class="metric-card">
        <strong>Sessao</strong>
        <span class="metric-value">${escapeHtml(sessionLabel)}</span>
        <span class="metric-foot">Canal preferido para executar os disparos.</span>
      </article>
    `;
  }

  function renderTimeline() {
    const steps = state.editor?.steps || [];
    if (!steps.length) {
      refs.timelinePreview.innerHTML = createEmptyState(
        "A timeline vai aparecer aqui assim que houver passos."
      );
      return;
    }

    let cumulativeDelay = 0;
    refs.timelinePreview.innerHTML = steps
      .map((step, index) => {
        cumulativeDelay += Math.max(0, toNumber(step.delayMs, 0));
        const snippet = String(step.message || "").trim();
        const snippetText = snippet
          ? escapeHtml(snippet.slice(0, 160))
          : "Sem texto definido; o passo envia apenas a midia anexada.";

        return `
          <article class="timeline-item">
            <div class="timeline-top">
              <div>
                <strong>Passo ${index + 1}</strong>
                <div class="step-meta">${
                  index === 0
                    ? "Entrada imediata no funil."
                    : `Executa ${formatRelativeDelay(step.delayMs)}.`
                }</div>
              </div>
              <span class="inline-chip">+${
                cumulativeDelay > 0 ? formatDuration(cumulativeDelay) : "agora"
              }</span>
            </div>
            <p>${snippetText}</p>
            <div class="timeline-chips">
              <span class="inline-chip"><i class="fa-regular fa-message"></i>${formatCount(
                snippet.length,
                "caractere",
                "caracteres"
              )}</span>
              <span class="inline-chip"><i class="fa-solid fa-paperclip"></i>${
                step.filename ? escapeHtml(step.filename) : "Sem anexo"
              }</span>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderSelectionSummary() {
    const selected = getSelectedCampaign();
    const focus = getEditorFocusCampaign();
    const insights = getCampaignInsights(focus);
    const status = selected
      ? getStatusConfig(focus.active ? "active" : "inactive")
      : getStatusConfig(state.editor?.active === false ? "inactive" : "active");

    refs.selectionSummary.innerHTML = `
      <div class="selection-hero">
        <div class="campaign-top">
          <div>
            <div class="selection-title">${escapeHtml(
              String(focus.name || "").trim() || "Nova campanha"
            )}</div>
            <div class="step-meta">${
              selected ? `Atualizada em ${escapeHtml(formatDateTime(insights.updatedAt))}` : "Ainda nao salva"
            }</div>
          </div>
          <span class="status-pill ${status.className}">${status.label}</span>
        </div>
        <p>${escapeHtml(insights.snippet)}</p>
      </div>

      <div class="selection-grid">
        <article>
          <span>Gatilho</span>
          <strong>${escapeHtml(insights.triggerStage)}</strong>
          <small>Lead entra no fluxo ao chegar nessa etapa do CRM.</small>
        </article>
        <article>
          <span>Sessao</span>
          <strong>${escapeHtml(getSessionModeLabel(insights.preferredSession))}</strong>
          <small>Usada como preferencia para os disparos automáticos.</small>
        </article>
        <article>
          <span>Janela total</span>
          <strong>${formatDelayBadge(insights.totalDelay)}</strong>
          <small>Tempo estimado entre o primeiro e o ultimo passo.</small>
        </article>
        <article>
          <span>Conteudo</span>
          <strong>${formatCompactNumber(insights.mediaSteps)} midia(s)</strong>
          <small>${formatCount(
            insights.textSteps,
            "passo com texto",
            "passos com texto"
          )} no editor atual.</small>
        </article>
      </div>
    `;
  }

  function renderSelectionHealth() {
    const focus = getEditorFocusCampaign();
    const insights = getCampaignInsights(focus);
    const stats = insights.stats || {};

    refs.selectionHealth.innerHTML = `
      <article>
        <span>Execucao</span>
        <strong>${formatCount(stats.active || 0, "lead ativo", "leads ativos")}</strong>
        <small>${formatCount(stats.pending || 0, "pendente", "pendentes")} e ${formatCount(
          stats.processing || 0,
          "processando",
          "processando"
        )} neste momento.</small>
      </article>
      <article>
        <span>Resultado</span>
        <strong>${formatCount(
          stats.completed || 0,
          "fluxo concluido",
          "fluxos concluidos"
        )}</strong>
        <small>${formatCount(stats.failed || 0, "falha", "falhas")} registradas para revisao.</small>
      </article>
      <article>
        <span>Cadencia</span>
        <strong>${formatCount(
          insights.delayedSteps,
          "espera configurada",
          "esperas configuradas"
        )}</strong>
        <small>${formatCount(
          insights.immediateSteps,
          "passo imediato",
          "passos imediatos"
        )} dentro da automacao.</small>
      </article>
    `;
  }

  function renderCampaignList() {
    if (!state.campaigns.length) {
      refs.campaignList.innerHTML = createEmptyState(
        "Nenhuma campanha criada ainda. Comece montando o primeiro funil."
      );
      return;
    }

    refs.campaignList.innerHTML = state.campaigns
      .map((campaign) => {
        const selected = Number(campaign.id) === Number(state.selectedCampaignId);
        const status = getStatusConfig(campaign.active ? "active" : "inactive");
        const snippet = getCampaignSnippet(campaign);
        const insights = getCampaignInsights(campaign);

        return `
          <button type="button" class="campaign-item ${
            selected ? "active" : ""
          }" data-campaign-id="${campaign.id}">
            <div class="campaign-top">
              <div>
                <div class="campaign-title">${escapeHtml(campaign.name)}</div>
                <div class="step-meta">${escapeHtml(campaign.triggerStage)} • ${formatCount(
                  insights.steps.length,
                  "passo",
                  "passos"
                )}</div>
              </div>
              <span class="status-pill ${status.className}">${status.label}</span>
            </div>

            <div class="campaign-meta">${escapeHtml(snippet)}</div>

            <div class="campaign-lines">
              <span class="inline-chip"><i class="fa-solid fa-stopwatch"></i>${formatDelayBadge(
                insights.totalDelay
              )}</span>
              <span class="inline-chip"><i class="fa-solid fa-paperclip"></i>${formatCount(
                insights.mediaSteps,
                "anexo",
                "anexos"
              )}</span>
              <span class="inline-chip"><i class="fa-solid fa-mobile-screen"></i>${escapeHtml(
                getSessionModeLabel(campaign.preferredSession)
              )}</span>
            </div>

            <div class="campaign-stats">
              <div>
                <strong>${formatCompactNumber(campaign.stats?.active || 0)}</strong>
                <span>Ativos</span>
              </div>
              <div>
                <strong>${formatCompactNumber(campaign.stats?.completed || 0)}</strong>
                <span>Concluidos</span>
              </div>
              <div>
                <strong>${formatCompactNumber(campaign.stats?.failed || 0)}</strong>
                <span>Falhas</span>
              </div>
            </div>
          </button>
        `;
      })
      .join("");
  }

  function renderEnrollmentSummary() {
    const selected = getSelectedCampaign();
    if (!selected) {
      refs.enrollmentSummary.innerHTML = createEmptyState(
        "Selecione uma campanha salva para acompanhar os enrollments."
      );
      return;
    }

    const stats = selected.stats || {};
    const nextSendAt = state.enrollments
      .map((item) => toNumber(item.nextSendAt, 0))
      .filter(Boolean)
      .sort((a, b) => a - b)[0];

    refs.enrollmentSummary.innerHTML = `
      <article class="enrollment-summary-card">
        <span>Ativos</span>
        <strong>${formatCompactNumber(stats.active || 0)}</strong>
      </article>
      <article class="enrollment-summary-card">
        <span>Pendentes</span>
        <strong>${formatCompactNumber(stats.pending || 0)}</strong>
      </article>
      <article class="enrollment-summary-card">
        <span>Proximo envio</span>
        <strong>${escapeHtml(nextSendAt ? formatDateTime(nextSendAt) : "Sem agenda")}</strong>
      </article>
      <article class="enrollment-summary-card">
        <span>Falhas</span>
        <strong>${formatCompactNumber(stats.failed || 0)}</strong>
      </article>
    `;
  }

  function renderEnrollments() {
    if (state.loadingEnrollments) {
      refs.enrollmentList.innerHTML = createEmptyState(
        "Carregando enrollments da campanha..."
      );
      return;
    }

    if (!state.selectedCampaignId) {
      refs.enrollmentList.innerHTML = createEmptyState(
        "Selecione uma campanha salva para acompanhar os leads inscritos."
      );
      return;
    }

    if (!state.enrollments.length) {
      refs.enrollmentList.innerHTML = createEmptyState(
        "Ainda nao ha leads inscritos nessa campanha."
      );
      return;
    }

    const totalSteps =
      (getSelectedCampaign()?.steps || []).length ||
      (state.editor?.steps || []).length ||
      1;

    refs.enrollmentList.innerHTML = state.enrollments
      .map((enrollment) => {
        const status = getStatusConfig(enrollment.status);
        const currentStepRaw = Math.max(0, toNumber(enrollment.currentStep, 0));
        const displayStep = Math.min(totalSteps, Math.max(1, currentStepRaw + 1));
        const progressPct =
          enrollment.status === "completed"
            ? 100
            : Math.min(
                100,
                Math.max(8, Math.round((displayStep / Math.max(totalSteps, 1)) * 100))
              );
        const lastTouch =
          enrollment.lastAttemptAt ||
          enrollment.processingStartedAt ||
          enrollment.updatedAt ||
          0;

        return `
          <article class="enrollment-item">
            <div class="enrollment-top">
              <div>
                <strong>${escapeHtml(
                  enrollment.contactName || enrollment.contactPhone
                )}</strong>
                <div class="step-meta">${escapeHtml(
                  formatPhone(enrollment.contactPhone)
                )}</div>
              </div>
              <span class="status-pill ${status.className}">${status.label}</span>
            </div>

            <div class="enrollment-progress">
              <div class="progress-head">
                <span>Passo ${displayStep}/${Math.max(totalSteps, 1)}</span>
                <span>${progressPct}%</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width:${progressPct}%"></div>
              </div>
            </div>

            <div class="enrollment-meta-grid">
              <div>
                <span>Proximo envio</span>
                <strong>${escapeHtml(
                  enrollment.nextSendAt
                    ? formatDateTime(enrollment.nextSendAt)
                    : enrollment.status === "completed"
                      ? "Fluxo concluido"
                      : "Sem agenda"
                )}</strong>
              </div>
              <div>
                <span>Tentativas</span>
                <strong>${formatCompactNumber(enrollment.attemptCount || 0)}</strong>
              </div>
              <div>
                <span>Ultima sessao</span>
                <strong>${escapeHtml(
                  enrollment.lastSessionName || "automatico"
                )}</strong>
              </div>
              <div>
                <span>Ultima atividade</span>
                <strong>${escapeHtml(
                  lastTouch ? formatDateTime(lastTouch) : "Sem atividade"
                )}</strong>
              </div>
              <div>
                <span>Status atual</span>
                <strong>${escapeHtml(status.label)}</strong>
              </div>
              <div>
                <span>Contato</span>
                <strong>${escapeHtml(
                  enrollment.contactName ? "Com nome salvo" : "Somente telefone"
                )}</strong>
              </div>
            </div>

            ${
              enrollment.lastError
                ? `<div class="enrollment-error">${escapeHtml(
                    enrollment.lastError
                  )}</div>`
                : ""
            }
          </article>
        `;
      })
      .join("");
  }

  function renderAll() {
    renderAccessCard();
    renderHeroHighlights();
    renderStats();
    renderEditorHeader();
    renderEditorOverview();
    renderSteps();
    renderMetrics();
    renderTimeline();
    renderSelectionSummary();
    renderSelectionHealth();
    renderCampaignList();
    renderEnrollmentSummary();
    renderEnrollments();
  }

  function focusCampaignNameInput() {
    window.requestAnimationFrame(() => {
      refs.campaignName?.focus();
      refs.campaignName?.select?.();
    });
  }

  function resolveSelectedCampaignId(explicitId) {
    const candidate = toNumber(explicitId, 0);
    if (
      candidate &&
      state.campaigns.some((campaign) => Number(campaign.id) === candidate)
    ) {
      return candidate;
    }

    if (
      state.selectedCampaignId &&
      state.campaigns.some(
        (campaign) => Number(campaign.id) === Number(state.selectedCampaignId)
      )
    ) {
      return Number(state.selectedCampaignId);
    }

    return state.campaigns[0]?.id || null;
  }

  async function loadCampaigns(options = {}) {
    state.loadingCampaigns = true;
    syncButtonStates();

    try {
      const response = await fetch("/api/drips/campaigns", {
        credentials: "include",
      });
      const payload = await response.json();

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Falha ao carregar campanhas drip.");
      }

      state.campaigns = Array.isArray(payload.campaigns) ? payload.campaigns : [];
      state.access = payload.access || state.access;
      state.stages =
        Array.isArray(payload.stages) && payload.stages.length
          ? payload.stages
          : state.stages;
      state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

      const shouldStayBlank =
        state.preferBlankEditor &&
        (options.selectedId == null || options.selectedId === "");
      const nextSelectedId = shouldStayBlank
        ? null
        : resolveSelectedCampaignId(options.selectedId);

      state.enrollments = [];

      if (nextSelectedId) {
        state.preferBlankEditor = false;
        state.selectedCampaignId = nextSelectedId;
        state.editor = cloneCampaignForEditor(getSelectedCampaign());
      } else if (!state.selectedCampaignId) {
        state.loadingEnrollments = false;
        state.editor = createBlankCampaign();
      } else {
        state.selectedCampaignId = null;
        state.loadingEnrollments = false;
        state.editor = createBlankCampaign();
      }

      renderAll();

      if (state.selectedCampaignId) {
        await loadEnrollments(state.selectedCampaignId);
      } else {
        state.enrollments = [];
        renderEnrollmentSummary();
        renderEnrollments();
      }
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Nao foi possivel carregar as campanhas.");
      renderAll();
    } finally {
      state.loadingCampaigns = false;
      syncButtonStates();
    }
  }

  async function loadEnrollments(campaignId) {
    if (!campaignId) {
      state.enrollments = [];
      state.loadingEnrollments = false;
      renderEnrollmentSummary();
      renderEnrollments();
      return;
    }

    const currentCampaignId = Number(campaignId);
    state.loadingEnrollments = true;
    renderEnrollmentSummary();
    renderEnrollments();

    try {
      const response = await fetch(
        `/api/drips/campaigns/${currentCampaignId}/enrollments?limit=15`,
        {
          credentials: "include",
        }
      );
      const payload = await response.json();

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Falha ao carregar enrollments.");
      }

      if (Number(state.selectedCampaignId) !== currentCampaignId) {
        return;
      }

      state.enrollments = Array.isArray(payload.enrollments)
        ? payload.enrollments
        : [];
    } catch (err) {
      console.error(err);
      if (Number(state.selectedCampaignId) === currentCampaignId) {
        state.enrollments = [];
        showMessage("error", err?.message || "Nao foi possivel carregar os leads.");
      }
    } finally {
      if (Number(state.selectedCampaignId) === currentCampaignId) {
        state.loadingEnrollments = false;
        renderEnrollmentSummary();
        renderEnrollments();
      }
    }
  }

  function resetEditor() {
    state.preferBlankEditor = true;
    state.selectedCampaignId = null;
    state.enrollments = [];
    state.loadingEnrollments = false;
    state.editor = createBlankCampaign();
    renderAll();
    focusCampaignNameInput();
  }

  function selectCampaign(campaignId) {
    const selectedId = Number(campaignId);
    if (!selectedId) return;

    state.preferBlankEditor = false;
    state.selectedCampaignId = selectedId;
    state.enrollments = [];
    state.loadingEnrollments = true;
    state.editor = cloneCampaignForEditor(
      state.campaigns.find((campaign) => Number(campaign.id) === selectedId)
    );
    renderAll();
    void loadEnrollments(selectedId);
  }

  function addStep() {
    state.editor.steps = renumberSteps([
      ...(state.editor.steps || []),
      createBlankStep((state.editor.steps || []).length, DAY_MS),
    ]);
    renderAll();
  }

  function removeStep(stepIndex) {
    if ((state.editor.steps || []).length <= 1) return;
    state.editor.steps = renumberSteps(
      state.editor.steps.filter((_, index) => index !== stepIndex)
    );
    renderAll();
  }

  function removeStepFile(stepIndex) {
    const step = state.editor.steps?.[stepIndex];
    if (!step) return;
    step.file = null;
    step.filename = null;
    renderAll();
  }

  function refreshStepCard(stepIndex, root) {
    const step = state.editor.steps?.[stepIndex];
    if (!step || !root) return;

    const badge = root.querySelector('[data-role="delay-badge"]');
    const title = root.querySelector('[data-role="step-title"]');
    const delayCopy = root.querySelector('[data-role="delay-copy"]');
    const preview = root.querySelector('[data-role="step-preview"]');
    const messageCount = root.querySelector('[data-role="message-count"]');
    const summaryChips = root.querySelectorAll(".step-summary .inline-chip");

    if (badge) {
      badge.textContent = formatDelayBadge(step.delayMs);
    }

    if (title) {
      title.textContent = getStepTitle(step, stepIndex);
    }

    if (delayCopy) {
      delayCopy.textContent = getStepDelayCopy(step, stepIndex);
    }

    if (preview) {
      preview.textContent = getStepPreview(step);
    }

    if (messageCount) {
      messageCount.textContent = formatCount(
        String(step.message || "").trim().length,
        "caractere",
        "caracteres"
      );
    }

    if (summaryChips[0]) {
      summaryChips[0].innerHTML = `<i class="fa-regular fa-message"></i>${escapeHtml(
        formatCount(String(step.message || "").trim().length, "caractere", "caracteres")
      )}`;
    }
  }

  function updateStepDelay(stepIndex, root) {
    const step = state.editor.steps?.[stepIndex];
    if (!step || !root) return;

    const valueInput = root.querySelector('[data-field="delay-value"]');
    const unitSelect = root.querySelector('[data-field="delay-unit"]');
    if (!valueInput || !unitSelect) return;

    step.delayMs = joinDelayMs(valueInput.value, unitSelect.value);
    refreshStepCard(stepIndex, root);
    renderEditorOverview();
    renderMetrics();
    renderTimeline();
    renderSelectionSummary();
    renderSelectionHealth();
    renderHeroHighlights();
  }

  function updateStepMessage(stepIndex, value, root) {
    const step = state.editor.steps?.[stepIndex];
    if (!step) return;
    step.message = value;
    refreshStepCard(stepIndex, root);
    renderTimeline();
    renderSelectionSummary();
  }

  async function handleStepFileSelection(stepIndex, file) {
    const step = state.editor.steps?.[stepIndex];
    if (!step || !file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      showMessage("error", "O arquivo excede o limite de 15MB.");
      return;
    }

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(String(event?.target?.result || ""));
      reader.onerror = () => reject(new Error("Nao foi possivel ler o arquivo."));
      reader.readAsDataURL(file);
    });

    step.file = String(dataUrl || "");
    step.filename = file.name || "arquivo";
    renderAll();
  }

  function buildPayload() {
    const name = String(state.editor?.name || "").trim();
    if (!name) {
      throw new Error("Informe o nome da campanha drip.");
    }

    const triggerStage = String(state.editor?.triggerStage || "").trim();
    if (!triggerStage) {
      throw new Error("Selecione um gatilho do CRM.");
    }

    const steps = renumberSteps(state.editor?.steps || []).map((step) => ({
      id: step.id || null,
      delayMs: Math.max(0, toNumber(step.delayMs, 0)),
      message: String(step.message || "").trim(),
      file: step.file || null,
      filename: step.filename || null,
    }));

    if (!steps.length) {
      throw new Error("Adicione pelo menos um passo.");
    }

    const invalidStepIndex = steps.findIndex((step) => !step.message && !step.file);
    if (invalidStepIndex >= 0) {
      throw new Error(`O passo ${invalidStepIndex + 1} precisa ter mensagem ou arquivo.`);
    }

    return {
      id: state.editor?.id || null,
      name,
      triggerStage,
      preferredSession: state.editor?.preferredSession || null,
      active: state.editor?.active !== false,
      steps,
    };
  }

  async function saveCampaign() {
    if (state.saving) return;

    let payload = null;
    try {
      payload = buildPayload();
    } catch (err) {
      showMessage("error", err?.message || "Revise os campos da campanha.");
      return;
    }

    state.saving = true;
    syncButtonStates();

    try {
      const response = await fetch("/api/drips/campaigns", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || "Nao foi possivel salvar a campanha.");
      }

      showMessage("success", "Campanha drip salva com sucesso.");
      state.preferBlankEditor = false;
      await loadCampaigns({ selectedId: result?.campaign?.id || null });
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Nao foi possivel salvar a campanha.");
    } finally {
      state.saving = false;
      syncButtonStates();
    }
  }

  async function deleteCampaign() {
    if (!state.editor?.id || state.deleting) return;

    const confirmed = window.confirm(
      "Tem certeza que deseja excluir esta campanha e todos os enrollments vinculados?"
    );
    if (!confirmed) return;

    state.deleting = true;
    syncButtonStates();

    try {
      const response = await fetch(`/api/drips/campaigns/${state.editor.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const result = await response.json();

      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || "Nao foi possivel excluir a campanha.");
      }

      showMessage("success", "Campanha removida com sucesso.");
      state.preferBlankEditor = true;
      state.selectedCampaignId = null;
      state.enrollments = [];
      state.editor = createBlankCampaign();
      await loadCampaigns();
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Nao foi possivel excluir a campanha.");
    } finally {
      state.deleting = false;
      syncButtonStates();
    }
  }

  function bindStaticEvents() {
    refs.createNewBtn.addEventListener("click", resetEditor);

    refs.reloadBtn.addEventListener("click", () => {
      void loadCampaigns({ selectedId: state.selectedCampaignId });
    });

    refs.editorConfigBtn?.addEventListener("click", () => {
      refs.editorConfigAnchor?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      refs.campaignName?.focus({ preventScroll: true });
    });

    refs.campaignName.addEventListener("input", (event) => {
      state.editor.name = event.target.value;
      renderEditorHeader();
      updateEditorStatusMessage();
      renderSelectionSummary();
      renderHeroHighlights();
    });

    refs.triggerStage.addEventListener("change", (event) => {
      state.editor.triggerStage = event.target.value;
      renderEditorOverview();
      renderMetrics();
      renderSelectionSummary();
      renderHeroHighlights();
      updateEditorStatusMessage();
    });

    refs.preferredSession.addEventListener("change", (event) => {
      state.editor.preferredSession = event.target.value;
      renderMetrics();
      renderSelectionSummary();
    });

    refs.campaignActive.addEventListener("change", (event) => {
      state.editor.active = Boolean(event.target.checked);
      renderEditorHeader();
      renderSelectionSummary();
    });

    refs.addStepBtn.addEventListener("click", addStep);
    refs.timelineAddStepBtn?.addEventListener("click", addStep);
    refs.saveBtn.addEventListener("click", () => {
      void saveCampaign();
    });
    refs.deleteBtn.addEventListener("click", () => {
      void deleteCampaign();
    });

    refs.campaignList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-campaign-id]");
      if (!trigger) return;
      selectCampaign(trigger.getAttribute("data-campaign-id"));
    });

    refs.stepsContainer.addEventListener("input", (event) => {
      const root = event.target.closest("[data-step-index]");
      if (!root) return;

      const stepIndex = toNumber(root.getAttribute("data-step-index"), -1);
      if (stepIndex < 0) return;

      if (event.target.matches('[data-field="message"]')) {
        updateStepMessage(stepIndex, event.target.value, root);
        return;
      }

      if (event.target.matches('[data-field="delay-value"]')) {
        updateStepDelay(stepIndex, root);
      }
    });

    refs.stepsContainer.addEventListener("change", (event) => {
      const root = event.target.closest("[data-step-index]");
      if (!root) return;

      const stepIndex = toNumber(root.getAttribute("data-step-index"), -1);
      if (stepIndex < 0) return;

      if (event.target.matches('[data-field="delay-unit"]')) {
        updateStepDelay(stepIndex, root);
        return;
      }

      if (event.target.matches('[data-field="file-input"]')) {
        const file = event.target.files?.[0] || null;
        void handleStepFileSelection(stepIndex, file).finally(() => {
          event.target.value = "";
        });
      }
    });

    refs.stepsContainer.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) return;

      const root = action.closest("[data-step-index]");
      if (!root) return;

      const stepIndex = toNumber(root.getAttribute("data-step-index"), -1);
      if (stepIndex < 0) return;

      const actionName = action.getAttribute("data-action");
      if (actionName === "remove-step") {
        removeStep(stepIndex);
        return;
      }

      if (actionName === "pick-file") {
        const input = root.querySelector('[data-field="file-input"]');
        input?.click();
        return;
      }

      if (actionName === "remove-file") {
        removeStepFile(stepIndex);
      }
    });
  }

  function initialize() {
    state.editor = createBlankCampaign();
    bindStaticEvents();
    renderAll();
    void loadCampaigns();
  }

  initialize();
})();
