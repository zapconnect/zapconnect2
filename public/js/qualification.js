(function () {
  const bootstrap = window.__QUALIFICATION_BOOTSTRAP__ || {};
  const DEFAULT_STAGES =
    Array.isArray(bootstrap.crmStages) && bootstrap.crmStages.length
      ? bootstrap.crmStages
      : ["Novo", "Qualificando", "Negociacao", "Fechado", "Perdido"];
  const DEFAULT_SAVE_FIELDS =
    Array.isArray(bootstrap.saveFields) && bootstrap.saveFields.length
      ? bootstrap.saveFields
      : ["none", "name", "interest", "budget", "urgency", "citystate", "notes"];
  const DEFAULT_STEP_TYPES =
    Array.isArray(bootstrap.stepTypes) && bootstrap.stepTypes.length
      ? bootstrap.stepTypes
      : ["text", "number", "options"];
  const MAX_STEPS = 10;

  const refs = {
    planName: document.getElementById("plan-name"),
    usagePill: document.getElementById("usage-pill"),
    crmPill: document.getElementById("crm-pill"),
    usageCounter: document.getElementById("usage-counter"),
    usagePercent: document.getElementById("usage-percent"),
    usageBar: document.getElementById("usage-bar"),
    usageFoot: document.getElementById("usage-foot"),
    usageActiveFlows: document.getElementById("usage-active-flows"),
    usageCompletedSessions: document.getElementById("usage-completed-sessions"),
    usageLimitLabel: document.getElementById("usage-limit-label"),
    upgradeBanner: document.getElementById("upgrade-banner"),
    createNewBtn: document.getElementById("create-new-btn"),
    reloadBtn: document.getElementById("reload-btn"),
    heroSelectedFlow: document.getElementById("hero-selected-flow"),
    heroSelectedFoot: document.getElementById("hero-selected-foot"),
    heroQuestionCount: document.getElementById("hero-question-count"),
    heroQuestionFoot: document.getElementById("hero-question-foot"),
    heroScoreTarget: document.getElementById("hero-score-target"),
    heroScoreFoot: document.getElementById("hero-score-foot"),
    statFlows: document.getElementById("stat-flows"),
    statFlowsFoot: document.getElementById("stat-flows-foot"),
    statActiveSessions: document.getElementById("stat-active-sessions"),
    statActiveFoot: document.getElementById("stat-active-foot"),
    statCompleted: document.getElementById("stat-completed"),
    statCompletedFoot: document.getElementById("stat-completed-foot"),
    statAverageScore: document.getElementById("stat-average-score"),
    statAverageFoot: document.getElementById("stat-average-foot"),
    editorBadge: document.getElementById("editor-badge"),
    editorStatus: document.getElementById("editor-status"),
    editorOverview: document.getElementById("editor-overview"),
    flowName: document.getElementById("flow-name"),
    flowTriggerKeywords: document.getElementById("flow-trigger-keywords"),
    flowActive: document.getElementById("flow-active"),
    flowActiveLabel: document.getElementById("flow-active-label"),
    flowActiveCopy: document.getElementById("flow-active-copy"),
    flowActiveShell: document.getElementById("flow-active-shell"),
    introMessage: document.getElementById("intro-message"),
    completionMessage: document.getElementById("completion-message"),
    hotThreshold: document.getElementById("hot-threshold"),
    warmThreshold: document.getElementById("warm-threshold"),
    hotStage: document.getElementById("hot-stage"),
    warmStage: document.getElementById("warm-stage"),
    coldStage: document.getElementById("cold-stage"),
    addStepBtn: document.getElementById("add-step-btn"),
    stepsContainer: document.getElementById("steps-container"),
    saveBtn: document.getElementById("save-btn"),
    deleteBtn: document.getElementById("delete-btn"),
    selectionSummary: document.getElementById("selection-summary"),
    selectionHealth: document.getElementById("selection-health"),
    flowList: document.getElementById("flow-list"),
    previewMetrics: document.getElementById("preview-metrics"),
    questionPreview: document.getElementById("question-preview"),
    sessionSummary: document.getElementById("session-summary"),
    sessionList: document.getElementById("session-list"),
  };

  const buttonMarkup = {
    reload: refs.reloadBtn ? refs.reloadBtn.innerHTML : "",
    save: refs.saveBtn ? refs.saveBtn.innerHTML : "",
    delete: refs.deleteBtn ? refs.deleteBtn.innerHTML : "",
  };

  const state = {
    flows: Array.isArray(bootstrap.flows) ? bootstrap.flows : [],
    access: bootstrap.access || {
      plan: "free",
      maxActiveFlows: 1,
      activeFlowsUsed: 0,
      activeFlowsRemaining: 1,
    },
    crmStages: DEFAULT_STAGES,
    saveFields: DEFAULT_SAVE_FIELDS,
    stepTypes: DEFAULT_STEP_TYPES,
    selectedFlowId: null,
    editor: null,
    sessions: [],
    loadingFlows: false,
    loadingSessions: false,
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

  function formatDateTime(timestamp) {
    const safeTs = toNumber(timestamp, 0);
    if (!safeTs) return "Sem registro";

    const date = new Date(safeTs);
    if (Number.isNaN(date.getTime())) return "Sem registro";

    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function createEmptyState(message) {
    return `<div class="empty-state">${escapeHtml(message)}</div>`;
  }

  function slugToken(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function labelForStage(stage) {
    return String(stage || "") === "Negociacao"
      ? "Negociacao"
      : String(stage || "");
  }

  function labelForStepType(type) {
    if (type === "number") return "Numero";
    if (type === "options") return "Opcoes";
    return "Texto";
  }

  function labelForSaveField(field) {
    const map = {
      none: "Nao salvar em campo fixo",
      name: "Nome",
      interest: "Interesse",
      budget: "Orcamento / deal_value",
      urgency: "Urgencia",
      citystate: "Cidade / estado",
      notes: "Nota livre no CRM",
    };
    return map[field] || field;
  }

  function createOption(index, seed = "") {
    const safeLabel = seed || `Opcao ${index + 1}`;
    return {
      id: `opt-${Date.now()}-${index + 1}-${slugToken(safeLabel) || "item"}`,
      label: safeLabel,
      value: safeLabel,
      score: 0,
    };
  }

  function createStep(index, overrides = {}) {
    return {
      id: `step-${Date.now()}-${index + 1}`,
      question: "",
      type: "text",
      field: "none",
      required: true,
      placeholder: "",
      helperText: "",
      baseScore: 0,
      options: [],
      ...overrides,
    };
  }

  function createDefaultFlow() {
    return {
      id: null,
      name: "",
      triggerKeywords: [],
      active: true,
      steps: [
        createStep(0, {
          question: "Qual seu nome?",
          field: "name",
          helperText: "Use uma pergunta simples para iniciar a conversa.",
        }),
        createStep(1, {
          question: "O que mais te interessa hoje?",
          field: "interest",
          helperText: "Exemplo: produto, servico, plano ou objetivo.",
        }),
        createStep(2, {
          question: "Qual seu orcamento aproximado?",
          type: "number",
          field: "budget",
        }),
      ],
      settings: {
        introMessage:
          "Vou te fazer algumas perguntas rapidas para direcionar melhor seu atendimento.",
        completionMessage:
          "Perfeito! Ja organizei suas respostas e vou seguir com o atendimento por aqui.",
        warmThreshold: 40,
        hotThreshold: 70,
        coldStage: "Novo",
        warmStage: "Qualificando",
        hotStage: "Negociacao",
      },
      stats: {
        activeSessions: 0,
        completedSessions: 0,
        cancelledSessions: 0,
        averageScore: null,
      },
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function cloneFlowForEditor(flow) {
    if (!flow) return createDefaultFlow();

    return {
      id: flow.id,
      name: String(flow.name || ""),
      triggerKeywords: Array.isArray(flow.triggerKeywords)
        ? [...flow.triggerKeywords]
        : [],
      active: flow.active !== false,
      steps: (flow.steps || []).map((step, index) => ({
        id: step.id || `step-${Date.now()}-${index + 1}`,
        question: String(step.question || ""),
        type: state.stepTypes.includes(step.type) ? step.type : "text",
        field: state.saveFields.includes(step.field) ? step.field : "none",
        required: step.required !== false,
        placeholder: String(step.placeholder || ""),
        helperText: String(step.helperText || ""),
        baseScore: Math.max(0, toNumber(step.baseScore, 0)),
        options: Array.isArray(step.options)
          ? step.options.map((option, optionIndex) => ({
              id:
                option.id ||
                `opt-${Date.now()}-${index + 1}-${optionIndex + 1}`,
              label: String(option.label || ""),
              value: String(option.value || option.label || ""),
              score: Math.max(0, toNumber(option.score, 0)),
            }))
          : [],
      })),
      settings: {
        introMessage: String(flow.settings?.introMessage || ""),
        completionMessage: String(flow.settings?.completionMessage || ""),
        warmThreshold: Math.max(0, toNumber(flow.settings?.warmThreshold, 40)),
        hotThreshold: Math.max(
          Math.max(0, toNumber(flow.settings?.warmThreshold, 40)),
          toNumber(flow.settings?.hotThreshold, 70)
        ),
        coldStage: flow.settings?.coldStage || "Novo",
        warmStage: flow.settings?.warmStage || "Qualificando",
        hotStage: flow.settings?.hotStage || "Negociacao",
      },
      stats: flow.stats || {
        activeSessions: 0,
        completedSessions: 0,
        cancelledSessions: 0,
        averageScore: null,
      },
      createdAt: toNumber(flow.createdAt, 0),
      updatedAt: toNumber(flow.updatedAt, 0),
    };
  }

  function getSelectedFlow() {
    return (
      state.flows.find((flow) => Number(flow.id) === Number(state.selectedFlowId)) ||
      null
    );
  }

  function getEditorFocusFlow() {
    const editor = state.editor || createDefaultFlow();
    const selected = getSelectedFlow();

    if (!selected) return editor;

    return {
      ...selected,
      ...editor,
      stats: selected.stats || editor.stats,
      createdAt: toNumber(selected.createdAt, 0),
      updatedAt: toNumber(selected.updatedAt, 0),
    };
  }

  function getFlowSnippet(flow) {
    const focus = flow || createDefaultFlow();
    const firstQuestion = (focus.steps || []).find((step) =>
      String(step.question || "").trim()
    );

    if (firstQuestion) {
      return String(firstQuestion.question || "").trim().slice(0, 140);
    }

    const intro = String(focus.settings?.introMessage || "").trim();
    if (intro) return intro.slice(0, 140);

    return "Fluxo sem preview definido ainda.";
  }

  function getSessionStatusConfig(status) {
    if (status === "completed") {
      return { className: "completed", label: "Concluida" };
    }
    if (status === "cancelled") {
      return { className: "cancelled", label: "Cancelada" };
    }
    return { className: "pending", label: "Em andamento" };
  }

  function getTotals() {
    return state.flows.reduce(
      (acc, flow) => {
        acc.activeFlows += flow.active ? 1 : 0;
        acc.activeSessions += toNumber(flow.stats?.activeSessions, 0);
        acc.completedSessions += toNumber(flow.stats?.completedSessions, 0);
        acc.cancelledSessions += toNumber(flow.stats?.cancelledSessions, 0);

        const avgScore = flow.stats?.averageScore;
        if (avgScore != null && Number.isFinite(Number(avgScore))) {
          const completedWeight = Math.max(1, toNumber(flow.stats?.completedSessions, 0));
          acc.totalScore += Number(avgScore) * completedWeight;
          acc.totalCompletedForAverage += completedWeight;
        }

        return acc;
      },
      {
        activeFlows: 0,
        activeSessions: 0,
        completedSessions: 0,
        cancelledSessions: 0,
        totalScore: 0,
        totalCompletedForAverage: 0,
      }
    );
  }

  function getFlowInsights(flow) {
    const focus = flow || createDefaultFlow();
    const steps = Array.isArray(focus.steps) ? focus.steps : [];
    const mappedFields = steps.filter((step) => step.field !== "none").length;
    const optionQuestions = steps.filter((step) => step.type === "options").length;
    const optionCount = steps.reduce(
      (acc, step) => acc + (Array.isArray(step.options) ? step.options.length : 0),
      0
    );
    const numberQuestions = steps.filter((step) => step.type === "number").length;
    const keywords = Array.isArray(focus.triggerKeywords) ? focus.triggerKeywords : [];
    const potentialMaxScore = steps.reduce((acc, step) => {
      const base = Math.max(0, toNumber(step.baseScore, 0));
      const optionScore =
        step.type === "options" && Array.isArray(step.options) && step.options.length
          ? Math.max(
              0,
              ...step.options.map((option) => Math.max(0, toNumber(option.score, 0)))
            )
          : 0;
      return acc + base + optionScore;
    }, 0);

    return {
      steps,
      mappedFields,
      optionQuestions,
      optionCount,
      numberQuestions,
      textQuestions: steps.filter((step) => step.type === "text").length,
      keywords,
      keywordCount: keywords.length,
      potentialMaxScore,
      hotThreshold: Math.max(0, toNumber(focus.settings?.hotThreshold, 70)),
      warmThreshold: Math.max(0, toNumber(focus.settings?.warmThreshold, 40)),
      hotStage: focus.settings?.hotStage || "Negociacao",
      warmStage: focus.settings?.warmStage || "Qualificando",
      coldStage: focus.settings?.coldStage || "Novo",
      snippet: getFlowSnippet(focus),
      stats: focus.stats || {
        activeSessions: 0,
        completedSessions: 0,
        cancelledSessions: 0,
        averageScore: null,
      },
      createdAt: toNumber(focus.createdAt, 0),
      updatedAt: toNumber(focus.updatedAt, 0),
    };
  }

  function getUsageState() {
    const access = state.access || {};
    const used = Math.max(0, toNumber(access.activeFlowsUsed, 0));
    const limit = access.maxActiveFlows;

    if (limit === "unlimited") {
      return {
        counter: `${formatCompactNumber(used)} ativos`,
        percent: "PRO",
        pct: Math.min(100, Math.max(24, Math.round(Math.log10(used + 10) * 22))),
        className: "is-pro",
        pillText: "Multiplos fluxos simultaneos",
        foot: "Plano Pro com multiplos fluxos ativos em paralelo.",
        limitLabel: "Ilimitado",
        showUpgrade: false,
      };
    }

    const numericLimit = Math.max(1, toNumber(limit, 1));
    const remaining = Math.max(0, toNumber(access.activeFlowsRemaining, 0));
    const pct = Math.min(100, Math.round((used / numericLimit) * 100));
    const className = pct >= 90 ? "is-alert" : pct >= 65 ? "is-warn" : "is-good";

    return {
      counter: `${formatCompactNumber(used)}/${formatCompactNumber(numericLimit)}`,
      percent: `${pct}%`,
      pct,
      className,
      pillText: remaining
        ? `${formatCompactNumber(remaining)} restante(s)`
        : "Limite atingido",
      foot: `${formatCompactNumber(remaining)} fluxo(s) ativo(s) restante(s) neste plano.`,
      limitLabel: `${formatCompactNumber(numericLimit)}/vez`,
      showUpgrade: true,
    };
  }

  function syncButtonStates() {
    refs.reloadBtn.disabled = state.loadingFlows;
    refs.reloadBtn.innerHTML = state.loadingFlows
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

  function renderAccess() {
    const usage = getUsageState();
    const totals = getTotals();

    refs.planName.textContent = String(state.access.plan || "free").toUpperCase();
    refs.usageCounter.textContent = usage.counter;
    refs.usagePercent.textContent = usage.percent;
    refs.usageFoot.textContent = usage.foot;
    refs.usageActiveFlows.textContent = formatCompactNumber(totals.activeFlows);
    refs.usageCompletedSessions.textContent = formatCompactNumber(
      totals.completedSessions
    );
    refs.usageLimitLabel.textContent = usage.limitLabel;

    refs.usageBar.style.width = `${usage.pct}%`;
    refs.usageBar.className = `usage-bar ${usage.className}`;

    refs.usagePill.className = `status-pill ${usage.className}`;
    refs.usagePill.textContent = usage.pillText;

    refs.crmPill.className = "status-pill is-good";
    refs.crmPill.textContent = `${formatCompactNumber(
      state.crmStages.length
    )} estagios CRM`;

    refs.upgradeBanner.classList.toggle("hidden", !usage.showUpgrade);
  }

  function renderHeroHighlights() {
    const selected = getSelectedFlow();
    const focus = getEditorFocusFlow();
    const insights = getFlowInsights(focus);
    const status = selected
      ? selected.active
        ? "Ativo"
        : "Pausado"
      : state.editor?.name
        ? "Rascunho"
        : "Novo fluxo";

    refs.heroSelectedFlow.textContent =
      String(focus.name || "").trim() || "Novo fluxo";
    refs.heroSelectedFoot.textContent = selected
      ? `${formatCount(insights.keywordCount, "palavra-chave", "palavras-chave")} • ${status}`
      : `${formatCount(
          insights.keywordCount,
          "gatilho configurado",
          "gatilhos configurados"
        )} • ${status}`;

    refs.heroQuestionCount.textContent = formatCompactNumber(insights.steps.length);
    refs.heroQuestionFoot.textContent = insights.steps.length
      ? `${formatCount(insights.mappedFields, "campo mapeado", "campos mapeados")} e ${formatCount(
          insights.optionQuestions,
          "pergunta com opcoes",
          "perguntas com opcoes"
        )}.`
      : "O editor ainda nao tem perguntas definidas.";

    refs.heroScoreTarget.textContent = `${formatCompactNumber(
      insights.hotThreshold
    )}+`;
    refs.heroScoreFoot.textContent = `${labelForStage(
      insights.hotStage
    )} quente • ${formatCompactNumber(insights.warmThreshold)}+ morno.`;
  }

  function renderStats() {
    const totals = getTotals();
    const totalFlows = state.flows.length;
    const averageScore = totals.totalCompletedForAverage
      ? Math.round(totals.totalScore / totals.totalCompletedForAverage)
      : null;

    refs.statFlows.textContent = formatCompactNumber(totalFlows);
    refs.statFlowsFoot.textContent = totalFlows
      ? `${formatCount(totals.activeFlows, "fluxo ativo", "fluxos ativos")} configurado(s)`
      : "Nenhum questionario salvo";

    refs.statActiveSessions.textContent = formatCompactNumber(totals.activeSessions);
    refs.statActiveFoot.textContent = totals.activeSessions
      ? "Leads respondendo ao quiz neste momento"
      : "Sem qualificacoes em andamento";

    refs.statCompleted.textContent = formatCompactNumber(totals.completedSessions);
    refs.statCompletedFoot.textContent = totals.completedSessions
      ? "Leads que terminaram todas as perguntas"
      : "Nenhum lead finalizado";

    refs.statAverageScore.textContent =
      averageScore == null ? "--" : String(averageScore);
    refs.statAverageFoot.textContent =
      averageScore == null
        ? "Sem dados consolidados"
        : "Media dos leads concluidos";
  }

  function renderStageOptions() {
    const stageOptions = state.crmStages
      .map(
        (stage) =>
          `<option value="${escapeHtml(stage)}">${escapeHtml(
            labelForStage(stage)
          )}</option>`
      )
      .join("");

    refs.hotStage.innerHTML = stageOptions;
    refs.warmStage.innerHTML = stageOptions;
    refs.coldStage.innerHTML = stageOptions;

    refs.hotStage.value = state.editor.settings.hotStage;
    refs.warmStage.value = state.editor.settings.warmStage;
    refs.coldStage.value = state.editor.settings.coldStage;
  }

  function renderFlowToggleState() {
    const current = state.editor || createDefaultFlow();
    const isActive = current.active !== false;

    refs.flowActive.checked = isActive;
    refs.flowActiveLabel.textContent = isActive ? "Fluxo ativo" : "Fluxo pausado";
    refs.flowActiveCopy.textContent = isActive
      ? "Leads novos entram nesse questionario antes da IA livre."
      : "Novos leads nao passam por esse quiz enquanto ele estiver pausado.";
    refs.flowActiveShell.classList.toggle("is-active", isActive);
    refs.flowActiveShell.classList.toggle("is-inactive", !isActive);
  }

  function updateEditorStatusMessage() {
    const selected = getSelectedFlow();
    const focus = getEditorFocusFlow();
    const insights = getFlowInsights(focus);

    if (selected) {
      refs.editorStatus.textContent = `${formatCount(
        insights.steps.length,
        "pergunta",
        "perguntas"
      )}, ${formatCount(
        selected.stats.activeSessions || 0,
        "sessao ativa",
        "sessoes ativas"
      )} e ${formatCount(
        selected.stats.completedSessions || 0,
        "lead concluido",
        "leads concluidos"
      )}.`;
      return;
    }

    refs.editorStatus.textContent =
      "Monte seu questionario e defina como o score move o lead no CRM.";
  }

  function renderEditorHeader() {
    const current = state.editor || createDefaultFlow();

    refs.editorBadge.textContent = current.id
      ? `Editando #${current.id}`
      : "Novo fluxo";
    refs.flowName.value = current.name || "";
    refs.flowTriggerKeywords.value = (current.triggerKeywords || []).join(", ");
    renderFlowToggleState();
    refs.introMessage.value = current.settings.introMessage || "";
    refs.completionMessage.value = current.settings.completionMessage || "";
    refs.hotThreshold.value = String(current.settings.hotThreshold);
    refs.warmThreshold.value = String(current.settings.warmThreshold);
    renderStageOptions();

    updateEditorStatusMessage();
    syncButtonStates();
  }

  function renderEditorOverview() {
    const insights = getFlowInsights(state.editor || createDefaultFlow());
    refs.editorOverview.innerHTML = `
      <article class="overview-card">
        <span>Perguntas</span>
        <strong>${formatCompactNumber(insights.steps.length)}</strong>
      </article>
      <article class="overview-card">
        <span>Campos mapeados</span>
        <strong>${formatCompactNumber(insights.mappedFields)}</strong>
      </article>
      <article class="overview-card">
        <span>Score potencial</span>
        <strong>${formatCompactNumber(insights.potentialMaxScore)}</strong>
      </article>
      <article class="overview-card">
        <span>Palavras-chave</span>
        <strong>${formatCompactNumber(insights.keywordCount)}</strong>
      </article>
    `;
  }

  function renderSelectionSummary() {
    const selected = getSelectedFlow();
    const focus = getEditorFocusFlow();
    const insights = getFlowInsights(focus);
    const status = selected
      ? selected.active
        ? "Ativo"
        : "Pausado"
      : state.editor?.name
        ? "Rascunho"
        : "Novo fluxo";
    const statusClass = selected
      ? selected.active
        ? "active"
        : "inactive"
      : state.editor?.active === false
        ? "inactive"
        : "pending";

    refs.selectionSummary.innerHTML = `
      <div class="selection-hero">
        <div class="campaign-top">
          <div>
            <div class="selection-title">${escapeHtml(
              String(focus.name || "").trim() || "Novo fluxo"
            )}</div>
            <div class="step-meta">${
              selected
                ? `Atualizado em ${escapeHtml(formatDateTime(insights.updatedAt))}`
                : "Ainda nao salvo"
            }</div>
          </div>
          <span class="status-pill ${statusClass}">${status}</span>
        </div>
        <p>${escapeHtml(insights.snippet)}</p>
      </div>

      <div class="selection-grid">
        <article>
          <span>Palavras-chave</span>
          <strong>${formatCompactNumber(insights.keywordCount)}</strong>
          <small>${
            insights.keywordCount
              ? escapeHtml(insights.keywords.join(", ").slice(0, 120))
              : "Sem gatilho textual; pode funcionar como fluxo padrao."
          }</small>
        </article>
        <article>
          <span>Saida quente</span>
          <strong>${formatCompactNumber(insights.hotThreshold)}+ pontos</strong>
          <small>Move para ${escapeHtml(labelForStage(insights.hotStage))}.</small>
        </article>
        <article>
          <span>Saida morna</span>
          <strong>${formatCompactNumber(insights.warmThreshold)}+ pontos</strong>
          <small>Move para ${escapeHtml(labelForStage(insights.warmStage))}.</small>
        </article>
        <article>
          <span>Saida fria</span>
          <strong>${escapeHtml(labelForStage(insights.coldStage))}</strong>
          <small>Recebe leads abaixo da faixa morna.</small>
        </article>
      </div>
    `;
  }

  function renderSelectionHealth() {
    const focus = getEditorFocusFlow();
    const insights = getFlowInsights(focus);
    const stats = insights.stats || {};

    refs.selectionHealth.innerHTML = `
      <article>
        <span>Execucao</span>
        <strong>${formatCount(
          stats.activeSessions || 0,
          "sessao ativa",
          "sessoes ativas"
        )}</strong>
        <small>${formatCount(
          stats.completedSessions || 0,
          "lead concluido",
          "leads concluidos"
        )} e ${formatCount(
          stats.cancelledSessions || 0,
          "cancelamento",
          "cancelamentos"
        )} registrados.</small>
      </article>
      <article>
        <span>Cobertura</span>
        <strong>${formatCount(
          insights.mappedFields,
          "campo mapeado",
          "campos mapeados"
        )}</strong>
        <small>${formatCount(
          insights.optionQuestions,
          "pergunta com opcoes",
          "perguntas com opcoes"
        )} e ${formatCount(
          insights.numberQuestions,
          "pergunta numerica",
          "perguntas numericas"
        )}.</small>
      </article>
      <article>
        <span>Score medio</span>
        <strong>${
          stats.averageScore == null
            ? "--"
            : formatCompactNumber(stats.averageScore)
        }</strong>
        <small>${
          stats.averageScore == null
            ? "Sem media suficiente para consolidar o fluxo."
            : "Media dos leads que finalizaram o questionario."
        }</small>
      </article>
    `;
  }

  function renderFlowList() {
    if (!state.flows.length) {
      refs.flowList.innerHTML = createEmptyState(
        "Nenhum fluxo criado ainda. Comece com um quiz simples de pre-venda."
      );
      return;
    }

    refs.flowList.innerHTML = state.flows
      .map((flow) => {
        const selected = Number(flow.id) === Number(state.selectedFlowId);
        const statusClass = flow.active ? "active" : "inactive";
        const statusLabel = flow.active ? "Ativo" : "Pausado";
        const insights = getFlowInsights(flow);
        const keywords =
          Array.isArray(flow.triggerKeywords) && flow.triggerKeywords.length
            ? flow.triggerKeywords.join(", ")
            : "Sem palavra-chave; funciona como fluxo padrao.";

        return `
          <button type="button" class="campaign-item ${
            selected ? "active" : ""
          }" data-flow-id="${flow.id}">
            <div class="campaign-top">
              <div>
                <div class="campaign-title">${escapeHtml(flow.name)}</div>
                <div class="step-meta">${formatCount(
                  (flow.steps || []).length,
                  "pergunta",
                  "perguntas"
                )}</div>
              </div>
              <span class="status-pill ${statusClass}">${statusLabel}</span>
            </div>

            <div class="campaign-meta">${escapeHtml(keywords)}</div>

            <div class="campaign-lines">
              <span class="inline-chip"><i class="fa-solid fa-bolt"></i>${formatCompactNumber(
                insights.hotThreshold
              )}+ quente</span>
              <span class="inline-chip"><i class="fa-solid fa-database"></i>${formatCount(
                insights.mappedFields,
                "campo",
                "campos"
              )}</span>
              <span class="inline-chip"><i class="fa-solid fa-tags"></i>${formatCount(
                insights.keywordCount,
                "gatilho",
                "gatilhos"
              )}</span>
            </div>

            <div class="campaign-stats">
              <div>
                <strong>${formatCompactNumber(flow.stats?.activeSessions || 0)}</strong>
                <span>Ativos</span>
              </div>
              <div>
                <strong>${formatCompactNumber(
                  flow.stats?.completedSessions || 0
                )}</strong>
                <span>Concluidos</span>
              </div>
              <div>
                <strong>${
                  flow.stats?.averageScore == null
                    ? "--"
                    : formatCompactNumber(flow.stats.averageScore)
                }</strong>
                <span>Score medio</span>
              </div>
            </div>
          </button>
        `;
      })
      .join("");
  }

  function renderPreviewMetrics() {
    const insights = getFlowInsights(state.editor || createDefaultFlow());

    refs.previewMetrics.innerHTML = `
      <article class="metric-card">
        <strong>Perguntas</strong>
        <span class="metric-value">${formatCompactNumber(insights.steps.length)}</span>
        <span class="metric-foot">Maximo de ${MAX_STEPS} perguntas por fluxo.</span>
      </article>
      <article class="metric-card">
        <strong>Campos mapeados</strong>
        <span class="metric-value">${formatCompactNumber(insights.mappedFields)}</span>
        <span class="metric-foot">Respostas com destino direto no CRM.</span>
      </article>
      <article class="metric-card">
        <strong>Score potencial</strong>
        <span class="metric-value">${formatCompactNumber(
          insights.potentialMaxScore
        )}</span>
        <span class="metric-foot">Soma estimada do score base com a melhor resposta.</span>
      </article>
      <article class="metric-card">
        <strong>Escalada quente</strong>
        <span class="metric-value">${formatCompactNumber(
          insights.hotThreshold
        )}+</span>
        <span class="metric-foot">Move para ${escapeHtml(
          labelForStage(insights.hotStage)
        )}.</span>
      </article>
    `;
  }

  function renderQuestionPreview() {
    const focus = getEditorFocusFlow();
    const insights = getFlowInsights(focus);
    const steps = insights.steps;

    if (!steps.length) {
      refs.questionPreview.innerHTML = createEmptyState(
        "As perguntas do quiz vao aparecer aqui."
      );
      return;
    }

    refs.questionPreview.innerHTML = `
      <article class="timeline-item">
        <div class="timeline-top">
          <div>
            <strong>Inicio do fluxo</strong>
            <div class="step-meta">Mensagem que abre a qualificacao.</div>
          </div>
          <span class="inline-chip">Entrada</span>
        </div>
        <p>${escapeHtml(focus.settings.introMessage || "")}</p>
      </article>
      ${steps
        .map((step, index) => {
          const optionLines =
            step.type === "options" && step.options.length
              ? `
                <div class="preview-answer-list">
                  ${step.options
                    .map(
                      (option) => `
                        <div class="preview-answer-item">
                          <strong>${escapeHtml(option.label)}</strong>
                          <p>Valor: ${escapeHtml(
                            option.value || option.label
                          )} • Score: +${formatCompactNumber(option.score)}</p>
                        </div>
                      `
                    )
                    .join("")}
                </div>
              `
              : "";

          return `
            <article class="timeline-item">
              <div class="timeline-top">
                <div>
                  <strong>Pergunta ${index + 1}</strong>
                  <div class="step-meta">${escapeHtml(
                    labelForStepType(step.type)
                  )} • ${escapeHtml(labelForSaveField(step.field))}</div>
                </div>
                <span class="score-inline">+${formatCompactNumber(
                  step.baseScore
                )}</span>
              </div>
              <p>${escapeHtml(step.question)}</p>
              <p class="flow-summary">${
                step.helperText
                  ? escapeHtml(step.helperText)
                  : "Sem texto auxiliar configurado para esta pergunta."
              }</p>
              ${optionLines}
            </article>
          `;
        })
        .join("")}
      <article class="timeline-item">
        <div class="timeline-top">
          <div>
            <strong>Encerramento</strong>
            <div class="step-meta">Faixas de score e destino no CRM.</div>
          </div>
          <span class="inline-chip">Saida</span>
        </div>
        <p>${escapeHtml(focus.settings.completionMessage || "")}</p>
        <div class="question-rule-list">
          <div class="question-rule-item">
            <strong>Quente: ${formatCompactNumber(insights.hotThreshold)}+ pontos</strong>
            <p>Move o lead para ${escapeHtml(labelForStage(insights.hotStage))}.</p>
          </div>
          <div class="question-rule-item">
            <strong>Morno: ${formatCompactNumber(insights.warmThreshold)}+ pontos</strong>
            <p>Move o lead para ${escapeHtml(labelForStage(insights.warmStage))}.</p>
          </div>
          <div class="question-rule-item">
            <strong>Frio: abaixo da faixa morna</strong>
            <p>Move o lead para ${escapeHtml(labelForStage(insights.coldStage))}.</p>
          </div>
        </div>
      </article>
    `;
  }

  function renderSessionSummary() {
    const selected = getSelectedFlow();

    if (!selected) {
      refs.sessionSummary.innerHTML = createEmptyState(
        "Selecione um fluxo salvo para acompanhar as sessoes."
      );
      return;
    }

    const stats = selected.stats || {};
    refs.sessionSummary.innerHTML = `
      <article class="enrollment-summary-card">
        <span>Ativas</span>
        <strong>${formatCompactNumber(stats.activeSessions || 0)}</strong>
      </article>
      <article class="enrollment-summary-card">
        <span>Concluidas</span>
        <strong>${formatCompactNumber(stats.completedSessions || 0)}</strong>
      </article>
      <article class="enrollment-summary-card">
        <span>Canceladas</span>
        <strong>${formatCompactNumber(stats.cancelledSessions || 0)}</strong>
      </article>
      <article class="enrollment-summary-card">
        <span>Score medio</span>
        <strong>${
          stats.averageScore == null
            ? "--"
            : formatCompactNumber(stats.averageScore)
        }</strong>
      </article>
    `;
  }

  function renderSessions() {
    if (state.loadingSessions) {
      refs.sessionList.innerHTML = createEmptyState(
        "Carregando sessoes recentes..."
      );
      return;
    }

    if (!state.selectedFlowId) {
      refs.sessionList.innerHTML = createEmptyState(
        "Selecione um fluxo salvo para ver os leads qualificados."
      );
      return;
    }

    if (!state.sessions.length) {
      refs.sessionList.innerHTML = createEmptyState(
        "Nenhuma sessao encontrada para esse fluxo ainda."
      );
      return;
    }

    const totalSteps = Math.max(
      1,
      (getEditorFocusFlow().steps || []).length || 1
    );

    refs.sessionList.innerHTML = state.sessions
      .map((session) => {
        const status = getSessionStatusConfig(session.status);
        const displayStep =
          session.status === "completed"
            ? totalSteps
            : Math.min(
                totalSteps,
                Math.max(1, toNumber(session.currentStep, 0) + 1)
              );
        const progressPct =
          session.status === "completed"
            ? 100
            : Math.min(
                100,
                Math.max(8, Math.round((displayStep / Math.max(totalSteps, 1)) * 100))
              );
        const answersPreview = Array.isArray(session.answers)
          ? session.answers
              .slice(0, 3)
              .map(
                (answer) => `
                  <div class="preview-answer-item">
                    <strong>${escapeHtml(answer.question)}</strong>
                    <p>${escapeHtml(answer.rawAnswer || "")}</p>
                  </div>
                `
              )
              .join("")
          : "";

        return `
          <article class="enrollment-item">
            <div class="enrollment-top">
              <div>
                <strong>${escapeHtml(
                  session.contactName || session.contactPhone
                )}</strong>
                <div class="step-meta">${escapeHtml(session.contactPhone || "")}</div>
              </div>
              <div class="question-reorder">
                <span class="session-score ${
                  session.score == null ? "is-empty" : ""
                }">${
                  session.score == null
                    ? "Sem score"
                    : `${formatCompactNumber(session.score)} pts`
                }</span>
                <span class="status-pill ${status.className}">${status.label}</span>
              </div>
            </div>

            <div class="enrollment-progress">
              <div class="progress-head">
                <span>Pergunta ${displayStep}/${totalSteps}</span>
                <span>${progressPct}%</span>
              </div>
              <div class="progress-track">
                <div class="progress-fill" style="width:${progressPct}%"></div>
              </div>
            </div>

            <div class="enrollment-meta-grid">
              <div>
                <span>Ultima atualizacao</span>
                <strong>${escapeHtml(formatDateTime(session.updatedAt))}</strong>
              </div>
              <div>
                <span>Inicio</span>
                <strong>${escapeHtml(formatDateTime(session.startedAt))}</strong>
              </div>
              <div>
                <span>Conclusao</span>
                <strong>${escapeHtml(
                  session.completedAt
                    ? formatDateTime(session.completedAt)
                    : "Em andamento"
                )}</strong>
              </div>
              <div>
                <span>Chat</span>
                <strong>${escapeHtml(session.chatId || "--")}</strong>
              </div>
              <div>
                <span>CRM</span>
                <strong>${
                  session.crmId == null
                    ? "Sem vinculo"
                    : `#${escapeHtml(String(session.crmId))}`
                }</strong>
              </div>
              <div>
                <span>Respostas</span>
                <strong>${formatCount(
                  Array.isArray(session.answers) ? session.answers.length : 0,
                  "item",
                  "itens"
                )}</strong>
              </div>
            </div>

            <div class="preview-answer-list">${answersPreview}</div>
          </article>
        `;
      })
      .join("");
  }

  function renderSteps() {
    const steps = state.editor.steps || [];
    if (!steps.length) {
      refs.stepsContainer.innerHTML = createEmptyState(
        "Adicione ao menos uma pergunta para montar o questionario."
      );
      return;
    }

    refs.stepsContainer.innerHTML = steps
      .map((step, index) => {
        const optionsSection =
          step.type === "options"
            ? `
              <div class="section-divider">
                <h3>Opcoes da pergunta</h3>
                <button type="button" class="btn btn-ghost" data-action="add-option">
                  <i class="fa-solid fa-plus"></i>
                  Adicionar opcao
                </button>
              </div>
              <div class="option-list">
                ${(step.options || [])
                  .map(
                    (option, optionIndex) => `
                      <div class="option-row" data-option-index="${optionIndex}">
                        <label class="field">
                          <span>Texto</span>
                          <input data-field="option-label" type="text" maxlength="120" value="${escapeHtml(
                            option.label || ""
                          )}" />
                        </label>
                        <label class="field">
                          <span>Valor interno</span>
                          <input data-field="option-value" type="text" maxlength="120" value="${escapeHtml(
                            option.value || ""
                          )}" />
                        </label>
                        <label class="field">
                          <span>Score</span>
                          <input data-field="option-score" type="number" min="0" max="100" step="1" value="${formatCompactNumber(
                            option.score
                          )}" />
                        </label>
                        <button type="button" class="btn btn-danger" data-action="remove-option">
                          <i class="fa-solid fa-trash"></i>
                          Remover
                        </button>
                      </div>
                    `
                  )
                  .join("")}
              </div>
            `
            : "";

        return `
          <article class="step-card question-card" data-step-index="${index}">
            <div class="step-card-top">
              <span class="step-order">${String(index + 1).padStart(2, "0")}</span>
              <div class="step-header-copy">
                <h3>Pergunta ${index + 1}</h3>
                <div class="question-type-meta">${
                  step.type === "options"
                    ? "Resposta guiada com opcoes pre-definidas."
                    : step.type === "number"
                      ? "Resposta numerica para score e CRM."
                      : "Resposta aberta com captura textual."
                }</div>
              </div>
              <span class="step-badge" data-role="badge">${
                step.type === "options"
                  ? `${(step.options || []).length} opcao(oes)`
                  : "Resposta livre"
              }</span>
            </div>

            <div class="question-summary">
              <span class="inline-chip" data-role="type-chip"><i class="fa-solid fa-layer-group"></i>${escapeHtml(
                labelForStepType(step.type)
              )}</span>
              <span class="inline-chip" data-role="field-chip"><i class="fa-solid fa-database"></i>${escapeHtml(
                labelForSaveField(step.field)
              )}</span>
              <span class="inline-chip" data-role="score-chip"><i class="fa-solid fa-gauge"></i>Score base +${formatCompactNumber(
                step.baseScore
              )}</span>
            </div>

            <div class="question-grid">
              <label class="field">
                <span>Pergunta</span>
                <textarea data-field="question" placeholder="Ex: Qual seu orcamento aproximado?">${escapeHtml(
                  step.question || ""
                )}</textarea>
              </label>

              <label class="field">
                <span>Tipo</span>
                <select data-field="type">
                  ${state.stepTypes
                    .map(
                      (type) => `
                        <option value="${escapeHtml(type)}" ${
                          step.type === type ? "selected" : ""
                        }>${escapeHtml(labelForStepType(type))}</option>
                      `
                    )
                    .join("")}
                </select>
              </label>

              <label class="field">
                <span>Salvar em</span>
                <select data-field="field">
                  ${state.saveFields
                    .map(
                      (field) => `
                        <option value="${escapeHtml(field)}" ${
                          step.field === field ? "selected" : ""
                        }>${escapeHtml(labelForSaveField(field))}</option>
                      `
                    )
                    .join("")}
                </select>
              </label>

              <label class="field">
                <span>Placeholder</span>
                <input data-field="placeholder" type="text" maxlength="180" value="${escapeHtml(
                  step.placeholder || ""
                )}" />
              </label>

              <label class="field">
                <span>Texto de apoio</span>
                <input data-field="helperText" type="text" maxlength="240" value="${escapeHtml(
                  step.helperText || ""
                )}" />
              </label>

              <label class="field">
                <span>Score base da resposta</span>
                <input data-field="baseScore" type="number" min="0" max="100" step="1" value="${formatCompactNumber(
                  step.baseScore
                )}" />
              </label>
            </div>

            ${optionsSection}

            <div class="question-actions">
              <div class="question-reorder">
                <button type="button" class="btn btn-ghost" data-action="move-up" ${
                  index === 0 ? "disabled" : ""
                }>
                  <i class="fa-solid fa-arrow-up"></i>
                  Subir
                </button>
                <button type="button" class="btn btn-ghost" data-action="move-down" ${
                  index === steps.length - 1 ? "disabled" : ""
                }>
                  <i class="fa-solid fa-arrow-down"></i>
                  Descer
                </button>
              </div>

              <button type="button" class="btn btn-danger" data-action="remove-step" ${
                steps.length <= 1 ? "disabled" : ""
              }>
                <i class="fa-solid fa-trash"></i>
                Remover pergunta
              </button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderAll() {
    renderAccess();
    renderHeroHighlights();
    renderStats();
    renderEditorHeader();
    renderEditorOverview();
    renderSteps();
    renderSelectionSummary();
    renderSelectionHealth();
    renderFlowList();
    renderPreviewMetrics();
    renderQuestionPreview();
    renderSessionSummary();
    renderSessions();
  }

  function focusFlowName() {
    window.requestAnimationFrame(() => {
      refs.flowName?.focus();
      refs.flowName?.select?.();
    });
  }

  function resolveSelectedFlowId(explicitId) {
    const candidate = toNumber(explicitId, 0);
    if (
      candidate &&
      state.flows.some((flow) => Number(flow.id) === candidate)
    ) {
      return candidate;
    }

    if (
      state.selectedFlowId &&
      state.flows.some((flow) => Number(flow.id) === Number(state.selectedFlowId))
    ) {
      return Number(state.selectedFlowId);
    }

    return state.flows[0]?.id || null;
  }

  async function loadFlows(options = {}) {
    state.loadingFlows = true;
    syncButtonStates();

    try {
      const response = await fetch("/api/qualification/flows", {
        credentials: "include",
      });
      const payload = await response.json();

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Falha ao carregar os fluxos.");
      }

      state.flows = Array.isArray(payload.flows) ? payload.flows : [];
      state.access = payload.access || state.access;
      state.crmStages =
        Array.isArray(payload.crmStages) && payload.crmStages.length
          ? payload.crmStages
          : state.crmStages;
      state.stepTypes =
        Array.isArray(payload.stepTypes) && payload.stepTypes.length
          ? payload.stepTypes
          : state.stepTypes;
      state.saveFields =
        Array.isArray(payload.saveFields) && payload.saveFields.length
          ? payload.saveFields
          : state.saveFields;

      const keepBlank =
        state.preferBlankEditor &&
        (options.selectedId == null || options.selectedId === "");
      const nextSelectedId = keepBlank
        ? null
        : resolveSelectedFlowId(options.selectedId);

      state.sessions = [];

      if (nextSelectedId) {
        state.preferBlankEditor = false;
        state.selectedFlowId = nextSelectedId;
        state.editor = cloneFlowForEditor(getSelectedFlow());
      } else {
        state.selectedFlowId = null;
        state.loadingSessions = false;
        state.editor = createDefaultFlow();
      }

      renderAll();

      if (state.selectedFlowId) {
        await loadSessions(state.selectedFlowId);
      }
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Nao foi possivel carregar os fluxos.");
      renderAll();
    } finally {
      state.loadingFlows = false;
      syncButtonStates();
    }
  }

  async function loadSessions(flowId) {
    if (!flowId) {
      state.sessions = [];
      state.loadingSessions = false;
      renderSessionSummary();
      renderSessions();
      return;
    }

    const currentId = Number(flowId);
    state.loadingSessions = true;
    renderSessionSummary();
    renderSessions();

    try {
      const response = await fetch(
        `/api/qualification/flows/${currentId}/sessions?limit=20`,
        {
          credentials: "include",
        }
      );
      const payload = await response.json();

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Falha ao carregar as sessoes.");
      }

      if (Number(state.selectedFlowId) !== currentId) {
        return;
      }

      state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    } catch (err) {
      console.error(err);
      if (Number(state.selectedFlowId) === currentId) {
        state.sessions = [];
        showMessage("error", err?.message || "Nao foi possivel carregar as sessoes.");
      }
    } finally {
      if (Number(state.selectedFlowId) === currentId) {
        state.loadingSessions = false;
        renderSessionSummary();
        renderSessions();
      }
    }
  }

  function resetEditor() {
    state.preferBlankEditor = true;
    state.selectedFlowId = null;
    state.sessions = [];
    state.loadingSessions = false;
    state.editor = createDefaultFlow();
    renderAll();
    focusFlowName();
  }

  function selectFlow(flowId) {
    const selectedId = Number(flowId);
    if (!selectedId) return;

    state.preferBlankEditor = false;
    state.selectedFlowId = selectedId;
    state.sessions = [];
    state.loadingSessions = true;
    state.editor = cloneFlowForEditor(
      state.flows.find((flow) => Number(flow.id) === selectedId)
    );
    renderAll();
    void loadSessions(selectedId);
  }

  function ensureOptionDefaults(step) {
    if (
      step.type === "options" &&
      (!Array.isArray(step.options) || step.options.length < 2)
    ) {
      step.options = [createOption(0, "Opcao 1"), createOption(1, "Opcao 2")];
    }
    if (step.type !== "options") {
      step.options = [];
    }
  }

  function renderDerivedPanels() {
    renderHeroHighlights();
    renderEditorOverview();
    renderSelectionSummary();
    renderSelectionHealth();
    renderPreviewMetrics();
    renderQuestionPreview();
    renderSessions();
  }

  function addStep() {
    if ((state.editor.steps || []).length >= MAX_STEPS) {
      showMessage("error", `O fluxo suporta no maximo ${MAX_STEPS} perguntas.`);
      return;
    }

    state.editor.steps.push(createStep(state.editor.steps.length));
    renderAll();
  }

  function removeStep(stepIndex) {
    if ((state.editor.steps || []).length <= 1) return;
    state.editor.steps.splice(stepIndex, 1);
    renderAll();
  }

  function moveStep(stepIndex, direction) {
    const nextIndex = stepIndex + direction;
    if (nextIndex < 0 || nextIndex >= state.editor.steps.length) return;
    const [step] = state.editor.steps.splice(stepIndex, 1);
    state.editor.steps.splice(nextIndex, 0, step);
    renderAll();
  }

  function addOption(stepIndex) {
    const step = state.editor.steps?.[stepIndex];
    if (!step) return;
    ensureOptionDefaults(step);
    step.options.push(createOption(step.options.length));
    renderAll();
  }

  function removeOption(stepIndex, optionIndex) {
    const step = state.editor.steps?.[stepIndex];
    if (!step || !Array.isArray(step.options)) return;
    if (step.options.length <= 2) {
      showMessage("error", "Perguntas de opcoes precisam de pelo menos duas opcoes.");
      return;
    }
    step.options.splice(optionIndex, 1);
    renderAll();
  }

  function refreshQuestionCard(stepIndex, root) {
    const step = state.editor.steps?.[stepIndex];
    if (!step || !root) return;

    const badge = root.querySelector('[data-role="badge"]');
    const typeChip = root.querySelector('[data-role="type-chip"]');
    const fieldChip = root.querySelector('[data-role="field-chip"]');
    const scoreChip = root.querySelector('[data-role="score-chip"]');

    if (badge) {
      badge.textContent =
        step.type === "options"
          ? `${(step.options || []).length} opcao(oes)`
          : "Resposta livre";
    }

    if (typeChip) {
      typeChip.innerHTML = `<i class="fa-solid fa-layer-group"></i>${escapeHtml(
        labelForStepType(step.type)
      )}`;
    }

    if (fieldChip) {
      fieldChip.innerHTML = `<i class="fa-solid fa-database"></i>${escapeHtml(
        labelForSaveField(step.field)
      )}`;
    }

    if (scoreChip) {
      scoreChip.innerHTML = `<i class="fa-solid fa-gauge"></i>Score base +${escapeHtml(
        formatCompactNumber(step.baseScore)
      )}`;
    }
  }

  function updateEditorField() {
    state.editor.name = refs.flowName.value;
    state.editor.triggerKeywords = refs.flowTriggerKeywords.value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    state.editor.active = !!refs.flowActive.checked;
    state.editor.settings.introMessage = refs.introMessage.value;
    state.editor.settings.completionMessage = refs.completionMessage.value;
    state.editor.settings.hotThreshold = Math.max(
      toNumber(refs.warmThreshold.value, 40),
      toNumber(refs.hotThreshold.value, 70)
    );
    state.editor.settings.warmThreshold = Math.max(
      0,
      Math.min(
        toNumber(refs.warmThreshold.value, 40),
        state.editor.settings.hotThreshold
      )
    );
    state.editor.settings.hotStage = refs.hotStage.value || "Negociacao";
    state.editor.settings.warmStage = refs.warmStage.value || "Qualificando";
    state.editor.settings.coldStage = refs.coldStage.value || "Novo";

    renderFlowToggleState();
    updateEditorStatusMessage();
    renderDerivedPanels();
  }

  function buildPayload() {
    const name = String(state.editor?.name || "").trim();
    if (!name) {
      throw new Error("Informe o nome do fluxo de qualificacao.");
    }

    const steps = (state.editor.steps || []).map((step, index) => {
      const question = String(step.question || "").trim();
      if (!question) {
        throw new Error(`A pergunta ${index + 1} precisa de um texto.`);
      }

      const normalized = {
        id: step.id || `step-${Date.now()}-${index + 1}`,
        question,
        type: state.stepTypes.includes(step.type) ? step.type : "text",
        field: state.saveFields.includes(step.field) ? step.field : "none",
        required: true,
        placeholder: String(step.placeholder || "").trim(),
        helperText: String(step.helperText || "").trim(),
        baseScore: Math.max(0, toNumber(step.baseScore, 0)),
        options: [],
      };

      if (normalized.type === "options") {
        const options = Array.isArray(step.options) ? step.options : [];
        if (options.length < 2) {
          throw new Error(
            `A pergunta ${index + 1} precisa de pelo menos duas opcoes.`
          );
        }

        normalized.options = options.map((option, optionIndex) => {
          const label = String(option.label || "").trim();
          const value = String(option.value || option.label || "").trim();
          if (!label) {
            throw new Error(
              `A opcao ${optionIndex + 1} da pergunta ${
                index + 1
              } precisa de um texto.`
            );
          }

          return {
            id: option.id || `opt-${Date.now()}-${index + 1}-${optionIndex + 1}`,
            label,
            value: value || label,
            score: Math.max(0, toNumber(option.score, 0)),
          };
        });
      }

      return normalized;
    });

    if (!steps.length) {
      throw new Error("Adicione pelo menos uma pergunta.");
    }

    if (steps.length > MAX_STEPS) {
      throw new Error(`O fluxo suporta no maximo ${MAX_STEPS} perguntas.`);
    }

    return {
      id: state.editor.id || null,
      name,
      triggerKeywords: state.editor.triggerKeywords || [],
      active: state.editor.active !== false,
      steps,
      settings: {
        introMessage: String(state.editor.settings.introMessage || "").trim(),
        completionMessage: String(
          state.editor.settings.completionMessage || ""
        ).trim(),
        warmThreshold: Math.max(
          0,
          toNumber(state.editor.settings.warmThreshold, 40)
        ),
        hotThreshold: Math.max(
          Math.max(0, toNumber(state.editor.settings.warmThreshold, 40)),
          toNumber(state.editor.settings.hotThreshold, 70)
        ),
        coldStage: state.editor.settings.coldStage || "Novo",
        warmStage: state.editor.settings.warmStage || "Qualificando",
        hotStage: state.editor.settings.hotStage || "Negociacao",
      },
    };
  }

  async function saveFlow() {
    if (state.saving) return;

    let payload = null;
    try {
      payload = buildPayload();
    } catch (err) {
      showMessage("error", err?.message || "Revise os campos do fluxo.");
      return;
    }

    state.saving = true;
    syncButtonStates();

    try {
      const response = await fetch("/api/qualification/flows", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || "Nao foi possivel salvar o fluxo.");
      }

      state.preferBlankEditor = false;
      showMessage("success", "Fluxo de qualificacao salvo com sucesso.");
      await loadFlows({ selectedId: result?.flow?.id || null });
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Nao foi possivel salvar o fluxo.");
    } finally {
      state.saving = false;
      syncButtonStates();
    }
  }

  async function deleteFlow() {
    if (!state.editor?.id || state.deleting) return;

    const confirmed = window.confirm(
      "Tem certeza que deseja excluir esse fluxo e o historico de sessoes vinculado a ele?"
    );
    if (!confirmed) return;

    state.deleting = true;
    syncButtonStates();

    try {
      const response = await fetch(`/api/qualification/flows/${state.editor.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const result = await response.json();

      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || "Nao foi possivel excluir o fluxo.");
      }

      state.preferBlankEditor = true;
      state.selectedFlowId = null;
      state.sessions = [];
      state.editor = createDefaultFlow();
      showMessage("success", "Fluxo removido com sucesso.");
      await loadFlows();
      focusFlowName();
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Nao foi possivel excluir o fluxo.");
    } finally {
      state.deleting = false;
      syncButtonStates();
    }
  }

  function bindStaticEvents() {
    refs.createNewBtn.addEventListener("click", resetEditor);
    refs.reloadBtn.addEventListener("click", () => {
      void loadFlows({ selectedId: state.selectedFlowId });
    });
    refs.saveBtn.addEventListener("click", () => {
      void saveFlow();
    });
    refs.deleteBtn.addEventListener("click", () => {
      void deleteFlow();
    });
    refs.addStepBtn.addEventListener("click", addStep);

    [
      refs.flowName,
      refs.flowTriggerKeywords,
      refs.introMessage,
      refs.completionMessage,
      refs.hotThreshold,
      refs.warmThreshold,
      refs.hotStage,
      refs.warmStage,
      refs.coldStage,
      refs.flowActive,
    ].forEach((element) => {
      if (!element) return;
      const eventName =
        element.tagName === "SELECT" ||
        element.type === "checkbox" ||
        element.type === "number"
          ? "change"
          : "input";
      element.addEventListener(eventName, updateEditorField);
      if (eventName !== "input") {
        element.addEventListener("input", updateEditorField);
      }
    });

    refs.flowList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-flow-id]");
      if (!trigger) return;
      selectFlow(trigger.getAttribute("data-flow-id"));
    });

    refs.stepsContainer.addEventListener("input", (event) => {
      const stepRoot = event.target.closest("[data-step-index]");
      if (!stepRoot) return;

      const stepIndex = toNumber(stepRoot.getAttribute("data-step-index"), -1);
      const step = state.editor.steps?.[stepIndex];
      if (!step) return;

      const field = event.target.getAttribute("data-field");
      if (field === "question") step.question = event.target.value;
      if (field === "placeholder") step.placeholder = event.target.value;
      if (field === "helperText") step.helperText = event.target.value;
      if (field === "baseScore") {
        step.baseScore = Math.max(0, toNumber(event.target.value, 0));
      }

      const optionRoot = event.target.closest("[data-option-index]");
      if (optionRoot) {
        const optionIndex = toNumber(optionRoot.getAttribute("data-option-index"), -1);
        const option = step.options?.[optionIndex];
        if (option) {
          if (field === "option-label") option.label = event.target.value;
          if (field === "option-value") option.value = event.target.value;
          if (field === "option-score") {
            option.score = Math.max(0, toNumber(event.target.value, 0));
          }
        }
      }

      refreshQuestionCard(stepIndex, stepRoot);
      renderDerivedPanels();
    });

    refs.stepsContainer.addEventListener("change", (event) => {
      const stepRoot = event.target.closest("[data-step-index]");
      if (!stepRoot) return;

      const stepIndex = toNumber(stepRoot.getAttribute("data-step-index"), -1);
      const step = state.editor.steps?.[stepIndex];
      if (!step) return;

      const field = event.target.getAttribute("data-field");
      if (field === "type") {
        step.type = event.target.value;
        ensureOptionDefaults(step);
        renderAll();
        return;
      }
      if (field === "field") {
        step.field = event.target.value;
      }

      refreshQuestionCard(stepIndex, stepRoot);
      renderDerivedPanels();
    });

    refs.stepsContainer.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) return;

      const stepRoot = action.closest("[data-step-index]");
      if (!stepRoot) return;

      const stepIndex = toNumber(stepRoot.getAttribute("data-step-index"), -1);
      if (stepIndex < 0) return;

      const actionName = action.getAttribute("data-action");
      if (actionName === "move-up") {
        moveStep(stepIndex, -1);
        return;
      }
      if (actionName === "move-down") {
        moveStep(stepIndex, 1);
        return;
      }
      if (actionName === "remove-step") {
        removeStep(stepIndex);
        return;
      }
      if (actionName === "add-option") {
        addOption(stepIndex);
        return;
      }

      const optionRoot = action.closest("[data-option-index]");
      if (optionRoot && actionName === "remove-option") {
        const optionIndex = toNumber(optionRoot.getAttribute("data-option-index"), -1);
        removeOption(stepIndex, optionIndex);
      }
    });
  }

  function initialize() {
    state.editor = createDefaultFlow();
    bindStaticEvents();
    renderAll();
    void loadFlows();
  }

  initialize();
})();
