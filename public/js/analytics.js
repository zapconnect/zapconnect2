(function () {
  const access = window.__ANALYTICS_ACCESS__ || {
    plan: "free",
    canExportPdf: false,
    maxHistoryDays: 7,
    fullHistoryEnabled: false,
  };

  const state = {
    days: Math.min(access.maxHistoryDays || 7, 7),
    reports: [],
    trend: null,
    selectedReportDate: null,
    charts: {
      themes: null,
      peak: null,
      trend: null,
    },
    loading: false,
  };

  const refs = {
    daysSelect: document.getElementById("days-select"),
    refreshBtn: document.getElementById("refresh-btn"),
    exportBtn: document.getElementById("export-btn"),
    upgradeBanner: document.getElementById("upgrade-banner"),
    planName: document.getElementById("plan-name"),
    historyCapPill: document.getElementById("history-cap-pill"),
    pdfCapPill: document.getElementById("pdf-cap-pill"),
    heroSelectedDate: document.getElementById("hero-selected-date"),
    heroSelectedWindow: document.getElementById("hero-selected-window"),
    heroReportCount: document.getElementById("hero-report-count"),
    heroReportFoot: document.getElementById("hero-report-foot"),
    heroPlanAccess: document.getElementById("hero-plan-access"),
    heroPlanFoot: document.getElementById("hero-plan-foot"),
    metaWindow: document.getElementById("meta-window"),
    metaMessages: document.getElementById("meta-messages"),
    metaModel: document.getElementById("meta-model"),
    metaGeneratedAt: document.getElementById("meta-generated-at"),
    historyList: document.getElementById("history-list"),
    summaryText: document.getElementById("summary-text"),
    reportDateBadge: document.getElementById("report-date-badge"),
    reportNotes: document.getElementById("report-notes"),
    satisfactionSummaryTitle: document.getElementById(
      "satisfaction-summary-title"
    ),
    satisfactionSummaryText: document.getElementById(
      "satisfaction-summary-text"
    ),
    meterTrack: document.getElementById("meter-track"),
    meterPositive: document.getElementById("meter-positive"),
    meterNeutral: document.getElementById("meter-neutral"),
    meterNegative: document.getElementById("meter-negative"),
    meterPositiveValue: document.getElementById("meter-positive-value"),
    meterNeutralValue: document.getElementById("meter-neutral-value"),
    meterNegativeValue: document.getElementById("meter-negative-value"),
    themesList: document.getElementById("themes-list"),
    unansweredList: document.getElementById("unanswered-list"),
    risksList: document.getElementById("risks-list"),
    suggestionsList: document.getElementById("suggestions-list"),
    healthConversations: document.getElementById("health-conversations"),
    healthMessages: document.getElementById("health-messages"),
    healthEngine: document.getElementById("health-engine"),
    healthEngineFoot: document.getElementById("health-engine-foot"),
    healthLimit: document.getElementById("health-limit"),
    healthLimitFoot: document.getElementById("health-limit-foot"),
    statConversations: document.getElementById("stat-conversations"),
    statWindow: document.getElementById("stat-window"),
    statSatisfaction: document.getElementById("stat-satisfaction"),
    statSatisfactionLabel: document.getElementById("stat-satisfaction-label"),
    statUnanswered: document.getElementById("stat-unanswered"),
    statUnansweredFoot: document.getElementById("stat-unanswered-foot"),
    statPeakHour: document.getElementById("stat-peak-hour"),
    statPeakCount: document.getElementById("stat-peak-count"),
    themesCanvas: document.getElementById("themes-chart"),
    peakCanvas: document.getElementById("peak-chart"),
    trendCanvas: document.getElementById("trend-chart"),
  };

  const buttonMarkup = {
    refresh: refs.refreshBtn ? refs.refreshBtn.innerHTML : "",
  };

  const cssVars = getComputedStyle(document.documentElement);
  const palette = {
    text: cssVars.getPropertyValue("--text").trim() || "#e8eaf0",
    textPrimary: cssVars.getPropertyValue("--text-primary").trim() || "#ffffff",
    textSecondary:
      cssVars.getPropertyValue("--text-secondary").trim() || "#aab0d9",
    accent: cssVars.getPropertyValue("--accent").trim() || "#6c64ef",
    accentStrong:
      cssVars.getPropertyValue("--accent-strong").trim() || "#4f6ef7",
    blue: cssVars.getPropertyValue("--blue").trim() || "#3b82f6",
    success: cssVars.getPropertyValue("--success").trim() || "#2ee6a6",
    grid: "rgba(55, 62, 89, 0.38)",
    tooltipBg: "rgba(10, 15, 28, 0.96)",
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatCompactNumber(value) {
    const numeric = Number(value);
    return new Intl.NumberFormat("pt-BR").format(
      Number.isFinite(numeric) ? numeric : 0
    );
  }

  function formatCountLabel(value, singular, plural) {
    const numeric = Number(value) || 0;
    return `${formatCompactNumber(numeric)} ${numeric === 1 ? singular : plural}`;
  }

  function formatPercentage(value) {
    const numeric = Number(value);
    return `${Math.round(Number.isFinite(numeric) ? numeric : 0)}%`;
  }

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

  function setLoading(next) {
    state.loading = next;

    refs.refreshBtn.disabled = next;
    refs.exportBtn.disabled = next;
    refs.daysSelect.disabled = next;

    refs.refreshBtn.innerHTML = next
      ? '<span class="loading-content"><span class="spinner-inline"></span><span class="loading-label">Atualizando</span></span>'
      : buttonMarkup.refresh;
  }

  function parseDateLike(value) {
    if (value == null || value === "") return null;

    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && String(value).trim() !== "") {
      const numericDate = new Date(asNumber);
      if (!Number.isNaN(numericDate.getTime())) return numericDate;
    }

    const text = String(value).trim();
    if (!text) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const dateOnly = new Date(`${text}T12:00:00`);
      if (!Number.isNaN(dateOnly.getTime())) return dateOnly;
    }

    const normalizedIso = text.replace(" ", "T");
    const parsed = new Date(normalizedIso);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    const fallback = new Date(text);
    if (!Number.isNaN(fallback.getTime())) return fallback;

    return null;
  }

  function formatDateLabel(dateString) {
    if (!dateString) return "Sem data";
    const date = parseDateLike(dateString);
    if (!date) return String(dateString);

    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  function formatDateTimeLabel(dateValue) {
    const date = parseDateLike(dateValue);
    if (!date) return "--";

    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatWindowRange(report) {
    if (!report || !report.windowStart || !report.windowEnd) {
      return "\u00daltimas 24h";
    }

    const start = parseDateLike(report.windowStart);
    const end = parseDateLike(report.windowEnd);
    if (!start || !end) {
      return "\u00daltimas 24h";
    }

    const formatter = new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });

    return `${formatter.format(start)} at\u00e9 ${formatter.format(end)}`;
  }

  function normalizePriority(priority) {
    if (priority === "high" || priority === "medium" || priority === "low") {
      return priority;
    }
    return "medium";
  }

  function formatPriority(priority) {
    switch (normalizePriority(priority)) {
      case "high":
        return "ALTA";
      case "low":
        return "BAIXA";
      default:
        return "M\u00c9DIA";
    }
  }

  function buildPlanFoot() {
    return access.canExportPdf
      ? `PDF liberado e hist\u00f3rico de at\u00e9 ${access.maxHistoryDays} dias.`
      : `PDF bloqueado e hist\u00f3rico de ${access.maxHistoryDays} dias.`;
  }

  function buildLimitState(source) {
    const conversationLimit = Boolean(source?.truncatedByConversationLimit);
    const tokenLimit = Boolean(source?.truncatedByTokenBudget);

    if (!conversationLimit && !tokenLimit) {
      return {
        title: "Cobertura completa",
        foot: "Sem truncamentos detectados nesta janela.",
      };
    }

    if (conversationLimit && tokenLimit) {
      return {
        title: "Cobertura parcial",
        foot:
          "O relat\u00f3rio reduziu a amostra de conversas e resumiu transcri\u00e7\u00f5es para caber no or\u00e7amento.",
      };
    }

    if (conversationLimit) {
      return {
        title: "Amostra reduzida",
        foot:
          "O volume de conversas foi limitado para manter o processamento est\u00e1vel.",
      };
    }

    return {
      title: "Transcri\u00e7\u00f5es resumidas",
      foot:
        "Parte do hist\u00f3rico foi resumida para caber no or\u00e7amento de tokens.",
    };
  }

  function getSelectedReport() {
    if (!state.reports.length) return null;

    if (state.selectedReportDate) {
      const selected = state.reports.find(
        (report) => report.reportDate === state.selectedReportDate
      );
      if (selected) return selected;
    }

    return state.reports[0] || null;
  }

  function createEmptyState(message) {
    return `<div class="empty-state">${escapeHtml(message)}</div>`;
  }

  function renderPlanCapabilities() {
    const planLabel = String(access.plan || "free").toUpperCase();

    refs.planName.textContent = planLabel;
    refs.heroPlanAccess.textContent = planLabel;
    refs.heroPlanFoot.textContent = buildPlanFoot();

    refs.historyCapPill.textContent = access.fullHistoryEnabled
      ? `Hist\u00f3rico ${access.maxHistoryDays}d`
      : `${access.maxHistoryDays} dias de hist\u00f3rico`;
    refs.historyCapPill.classList.toggle("is-active", Boolean(access.fullHistoryEnabled));
    refs.historyCapPill.classList.toggle("is-locked", !access.fullHistoryEnabled);

    refs.pdfCapPill.textContent = access.canExportPdf
      ? "PDF liberado"
      : "PDF bloqueado";
    refs.pdfCapPill.classList.toggle("is-active", Boolean(access.canExportPdf));
    refs.pdfCapPill.classList.toggle("is-locked", !access.canExportPdf);

    refs.exportBtn.classList.toggle("is-locked", !access.canExportPdf);
  }

  function renderHero(report) {
    refs.heroSelectedDate.textContent = report
      ? formatDateLabel(report.reportDate)
      : "Sem relat\u00f3rio";
    refs.heroSelectedWindow.textContent = report
      ? formatWindowRange(report)
      : "\u00daltimas 24h";

    refs.heroReportCount.textContent = formatCompactNumber(state.reports.length);
    refs.heroReportFoot.textContent = state.reports.length
      ? `${formatCountLabel(state.reports.length, "relat\u00f3rio", "relat\u00f3rios")} nos \u00faltimos ${state.days} dias`
      : `Nenhum relat\u00f3rio nos \u00faltimos ${state.days} dias`;
  }

  function renderNotes(report) {
    const notes = report?.data?.notes || [];

    if (!notes.length) {
      refs.reportNotes.innerHTML = createEmptyState(
        "Observa\u00e7\u00f5es adicionais aparecer\u00e3o aqui quando houver algo relevante."
      );
      return;
    }

    refs.reportNotes.innerHTML = notes
      .map(
        (note) =>
          `<span><i class="fa-solid fa-circle-info"></i>${escapeHtml(note)}</span>`
      )
      .join("");
  }

  function renderThemeList(report) {
    const items = report?.data?.themes || [];

    if (!items.length) {
      refs.themesList.innerHTML = createEmptyState(
        "Os temas mais frequentes aparecer\u00e3o aqui."
      );
      return;
    }

    refs.themesList.innerHTML = items
      .map((item, index) => {
        const share = Math.round((Number(item.share) || 0) * 100);
        return `
          <article class="theme-item">
            <div class="theme-top">
              <span class="theme-rank">${String(index + 1).padStart(2, "0")}</span>
              <div class="theme-meta">
                <h3>${escapeHtml(item.topic || "Tema sem nome")}</h3>
                <p>${escapeHtml(item.summary || "Sem resumo adicional para este tema.")}</p>
              </div>
              <span class="theme-share">${formatPercentage(share)}</span>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderHistory(reports) {
    if (!reports.length) {
      refs.historyList.innerHTML = createEmptyState(
        "Ainda n\u00e3o h\u00e1 relat\u00f3rios no per\u00edodo selecionado."
      );
      return;
    }

    const selected = getSelectedReport();

    refs.historyList.innerHTML = reports
      .map((report) => {
        const active =
          selected && selected.reportDate === report.reportDate ? "active" : "";
        const conversations = report?.data?.source?.conversationsAnalyzed || 0;
        const score = report?.data?.satisfaction?.score || 0;
        const engineLabel = report?.data?.source?.fallbackUsed
          ? "Fallback local"
          : report?.data?.model
            ? "IA ativa"
            : "Sem modelo";

        return `
          <button class="history-item ${active}" type="button" data-report-date="${escapeHtml(report.reportDate)}">
            <div class="history-top">
              <span class="history-date">${escapeHtml(formatDateLabel(report.reportDate))}</span>
              <span class="history-score">${formatPercentage(score)}</span>
            </div>
            <div class="history-meta">
              <span><i class="fa-regular fa-message"></i>${escapeHtml(
                formatCountLabel(conversations, "conversa", "conversas")
              )}</span>
              <span><i class="fa-solid fa-wand-magic-sparkles"></i>${escapeHtml(engineLabel)}</span>
            </div>
          </button>
        `;
      })
      .join("");

    refs.historyList.querySelectorAll("[data-report-date]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedReportDate = button.getAttribute("data-report-date");
        render();
      });
    });
  }

  function renderQuestions(report) {
    const items = report?.data?.unansweredQuestions || [];

    if (!items.length) {
      refs.unansweredList.innerHTML = createEmptyState(
        "Nenhuma pergunta cr\u00edtica sem resposta apareceu neste relat\u00f3rio."
      );
      return;
    }

    refs.unansweredList.innerHTML = items
      .map((item) => {
        const occurrences = Number(item.occurrences) || 0;
        const chatChip = item.chatId
          ? `<span class="inline-chip"><i class="fa-solid fa-hashtag"></i>${escapeHtml(
              item.chatId
            )}</span>`
          : "";

        return `
          <article class="bullet-item">
            <h3>${escapeHtml(item.question || "Pergunta sem texto")}</h3>
            <p>${escapeHtml(item.reason || "Sem contexto adicional para esta falha.")}</p>
            <div class="bullet-meta">
              <span class="inline-chip"><i class="fa-solid fa-repeat"></i>${escapeHtml(
                formatCountLabel(occurrences, "ocorr\u00eancia", "ocorr\u00eancias")
              )}</span>
              ${chatChip}
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderRisks(report) {
    const items = report?.data?.risks || [];

    if (!items.length) {
      refs.risksList.innerHTML = createEmptyState(
        "Nenhum risco relevante foi destacado neste recorte."
      );
      return;
    }

    refs.risksList.innerHTML = items
      .map(
        (risk, index) => `
          <article class="risk-item">
            <h3>Risco ${String(index + 1).padStart(2, "0")}</h3>
            <p>${escapeHtml(risk)}</p>
          </article>
        `
      )
      .join("");
  }

  function renderSuggestions(report) {
    const items = report?.data?.promptSuggestions || [];

    if (!items.length) {
      refs.suggestionsList.innerHTML = createEmptyState(
        "Nenhuma sugest\u00e3o dispon\u00edvel para este relat\u00f3rio."
      );
      return;
    }

    refs.suggestionsList.innerHTML = items
      .map((item) => {
        const priority = normalizePriority(item.priority);

        return `
          <article class="suggestion-item">
            <h3>${escapeHtml(item.title || "Sugest\u00e3o sem t\u00edtulo")}</h3>
            <p>${escapeHtml(item.suggestion || "Sem sugest\u00e3o detalhada.")}</p>
            <div class="suggestion-meta">
              <span class="priority-pill priority-${priority}">${formatPriority(
                priority
              )}</span>
              <span>${escapeHtml(
                item.why || "Sem justificativa adicional para esta recomenda\u00e7\u00e3o."
              )}</span>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderSatisfaction(report) {
    const satisfaction = report?.data?.satisfaction || {};
    const score =
      typeof satisfaction.score === "number" ? Math.round(satisfaction.score) : 0;
    const label = satisfaction.label || "Sem dados suficientes";
    const summary =
      satisfaction.summary ||
      "Quando houver mais conversa analisada, este bloco mostra o clima predominante das intera\u00e7\u00f5es.";

    refs.satisfactionSummaryTitle.textContent = `${label}${
      score > 0 ? ` (${score}%)` : ""
    }`;
    refs.satisfactionSummaryText.textContent = summary;

    const positive = Math.max(0, Number(satisfaction.positive) || 0);
    const neutral = Math.max(0, Number(satisfaction.neutral) || 0);
    const negative = Math.max(0, Number(satisfaction.negative) || 0);
    const total = positive + neutral + negative;

    const positiveWidth = total ? (positive / total) * 100 : 0;
    const neutralWidth = total ? (neutral / total) * 100 : 0;
    const negativeWidth = total ? (negative / total) * 100 : 0;

    refs.meterTrack.classList.toggle("is-empty", total === 0);
    refs.meterPositive.style.width = `${positiveWidth}%`;
    refs.meterNeutral.style.width = `${neutralWidth}%`;
    refs.meterNegative.style.width = `${negativeWidth}%`;
    refs.meterPositiveValue.textContent = formatPercentage(positiveWidth);
    refs.meterNeutralValue.textContent = formatPercentage(neutralWidth);
    refs.meterNegativeValue.textContent = formatPercentage(negativeWidth);
  }

  function renderStats(report) {
    const source = report?.data?.source || {};
    const satisfaction = report?.data?.satisfaction || {};
    const peakHour = report?.data?.peakHours?.[0] || null;
    const unansweredCount = report?.data?.unansweredQuestions?.length || 0;

    refs.statConversations.textContent = formatCompactNumber(
      source.conversationsAnalyzed || 0
    );
    refs.statWindow.textContent = formatWindowRange(report);
    refs.statSatisfaction.textContent =
      typeof satisfaction.score === "number" && satisfaction.score > 0
        ? `${Math.round(satisfaction.score)}%`
        : "\u2014";
    refs.statSatisfactionLabel.textContent = satisfaction.label || "Sem dados";
    refs.statUnanswered.textContent = formatCompactNumber(unansweredCount);
    refs.statUnansweredFoot.textContent = unansweredCount
      ? "Itens pedem ajuste no prompt"
      : "Nenhuma lacuna cr\u00edtica detectada";
    refs.statPeakHour.textContent = peakHour ? peakHour.label : "\u2014";
    refs.statPeakCount.textContent = peakHour
      ? formatCountLabel(peakHour.count || 0, "conversa ativa", "conversas ativas")
      : "Sem pico detectado";
  }

  function renderMeta(report) {
    const source = report?.data?.source || {};
    const generatedAt = report?.data?.generatedAt || report?.updatedAt || null;

    refs.metaWindow.textContent = formatWindowRange(report);
    refs.metaMessages.textContent = formatCountLabel(
      source.estimatedMessages || 0,
      "mensagem",
      "mensagens"
    );
    refs.metaModel.textContent = source.fallbackUsed
      ? "Fallback local"
      : report?.data?.model || "Heur\u00edsticas locais";
    refs.metaGeneratedAt.textContent = generatedAt
      ? formatDateTimeLabel(generatedAt)
      : "--";
  }

  function renderHealth(report) {
    const source = report?.data?.source || {};
    const generatedAt = report?.data?.generatedAt || report?.updatedAt || null;
    const limitState = buildLimitState(source);

    refs.healthConversations.textContent = formatCountLabel(
      source.conversationsAnalyzed || 0,
      "conversa",
      "conversas"
    );
    refs.healthMessages.textContent = formatCountLabel(
      source.estimatedMessages || 0,
      "mensagem estimada",
      "mensagens estimadas"
    );
    refs.healthEngine.textContent = source.fallbackUsed
      ? "Fallback local ativado"
      : report?.data?.model
        ? `IA: ${report.data.model}`
        : "Modelo n\u00e3o informado";
    refs.healthEngineFoot.textContent = source.fallbackUsed
      ? "A IA de analytics n\u00e3o respondeu nesta gera\u00e7\u00e3o; o sistema completou o resumo com heur\u00edsticas locais."
      : generatedAt
        ? `Relat\u00f3rio gerado em ${formatDateTimeLabel(generatedAt)}.`
        : "Aguardando uma gera\u00e7\u00e3o conclu\u00edda.";
    refs.healthLimit.textContent = limitState.title;
    refs.healthLimitFoot.textContent = limitState.foot;
  }

  function destroyCharts() {
    ["themes", "peak", "trend"].forEach((key) => {
      if (state.charts[key]) {
        state.charts[key].destroy();
        state.charts[key] = null;
      }
    });
  }

  function createPlaceholderChart(canvas, label) {
    if (!canvas || typeof Chart === "undefined") return null;

    return new Chart(canvas, {
      type: "bar",
      data: {
        labels: [label],
        datasets: [
          {
            data: [0],
            backgroundColor: "rgba(82, 182, 255, 0.16)",
            borderRadius: 14,
            borderSkipped: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true },
        },
      },
    });
  }

  function buildTrendPayload() {
    if (state.trend && Array.isArray(state.trend.labels)) {
      return state.trend;
    }

    const ordered = state.reports
      .slice()
      .sort((a, b) => String(a.reportDate).localeCompare(String(b.reportDate)));

    return {
      labels: ordered.map((report) => report.reportDate),
      satisfaction: ordered.map(
        (report) => report?.data?.satisfaction?.score || 0
      ),
      unanswered: ordered.map(
        (report) => report?.data?.unansweredQuestions?.length || 0
      ),
      conversations: ordered.map(
        (report) => report?.data?.source?.conversationsAnalyzed || 0
      ),
    };
  }

  function renderCharts(report, trend) {
    if (typeof Chart === "undefined") return;

    destroyCharts();

    const themeLabels = (report?.data?.themes || []).map((item) => item.topic);
    const themeData = (report?.data?.themes || []).map((item) => item.count);

    state.charts.themes = themeLabels.length
      ? new Chart(refs.themesCanvas, {
          type: "bar",
          data: {
            labels: themeLabels,
            datasets: [
              {
                data: themeData,
                backgroundColor: [
                  "#52b6ff",
                  "#6c64ef",
                  "#2ee6a6",
                  "#f4c75d",
                  "#ff8c7a",
                ],
                borderRadius: 14,
                borderSkipped: false,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: "y",
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: palette.tooltipBg,
                borderColor: "rgba(255, 255, 255, 0.08)",
                borderWidth: 1,
                titleColor: palette.textPrimary,
                bodyColor: palette.text,
              },
            },
            scales: {
              x: {
                beginAtZero: true,
                ticks: { color: palette.textSecondary, precision: 0 },
                grid: { color: palette.grid },
              },
              y: {
                ticks: { color: palette.textPrimary },
                grid: { display: false },
              },
            },
          },
        })
      : createPlaceholderChart(refs.themesCanvas, "Sem dados");

    const peakLabels = (report?.data?.peakHours || []).map((item) => item.label);
    const peakData = (report?.data?.peakHours || []).map((item) => item.count);

    state.charts.peak = peakLabels.length
      ? new Chart(refs.peakCanvas, {
          type: "bar",
          data: {
            labels: peakLabels,
            datasets: [
              {
                data: peakData,
                backgroundColor: peakData.map((_, index) =>
                  index % 2 === 0 ? "#52b6ff" : "#6c64ef"
                ),
                borderRadius: 12,
                borderSkipped: false,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: palette.tooltipBg,
                borderColor: "rgba(255, 255, 255, 0.08)",
                borderWidth: 1,
                titleColor: palette.textPrimary,
                bodyColor: palette.text,
              },
            },
            scales: {
              x: {
                ticks: { color: palette.textSecondary },
                grid: { display: false },
              },
              y: {
                beginAtZero: true,
                ticks: { color: palette.textSecondary, precision: 0 },
                grid: { color: palette.grid },
              },
            },
          },
        })
      : createPlaceholderChart(refs.peakCanvas, "Sem dados");

    const trendLabels = Array.isArray(trend?.labels) ? trend.labels : [];
    const trendData = Array.isArray(trend?.satisfaction) ? trend.satisfaction : [];

    state.charts.trend = trendLabels.length
      ? new Chart(refs.trendCanvas, {
          type: "line",
          data: {
            labels: trendLabels.map(formatDateLabel),
            datasets: [
              {
                label: "Satisfa\u00e7\u00e3o estimada",
                data: trendData,
                borderColor: palette.accentStrong,
                backgroundColor: "rgba(82, 182, 255, 0.16)",
                fill: true,
                tension: 0.34,
                pointRadius: 4,
                pointHoverRadius: 5,
                pointBackgroundColor: palette.success,
                pointBorderColor: palette.textPrimary,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: palette.tooltipBg,
                borderColor: "rgba(255, 255, 255, 0.08)",
                borderWidth: 1,
                titleColor: palette.textPrimary,
                bodyColor: palette.text,
              },
            },
            scales: {
              x: {
                ticks: { color: palette.textSecondary },
                grid: { display: false },
              },
              y: {
                beginAtZero: true,
                max: 100,
                ticks: { color: palette.textSecondary },
                grid: { color: palette.grid },
              },
            },
          },
        })
      : createPlaceholderChart(refs.trendCanvas, "Sem hist\u00f3rico");
  }

  function setEmptyContent(message) {
    renderPlanCapabilities();
    renderHero(null);

    refs.summaryText.textContent = message;
    refs.reportDateBadge.textContent = "Sem relat\u00f3rio";
    refs.satisfactionSummaryTitle.textContent = "Sem dados suficientes";
    refs.satisfactionSummaryText.textContent =
      "Quando houver mais conversa analisada, este bloco mostra o clima predominante das intera\u00e7\u00f5es.";
    refs.reportNotes.innerHTML = createEmptyState(
      "Observa\u00e7\u00f5es adicionais aparecer\u00e3o aqui quando houver algo relevante."
    );
    refs.themesList.innerHTML = createEmptyState(
      "Os temas mais frequentes aparecer\u00e3o aqui."
    );
    refs.historyList.innerHTML = createEmptyState(
      "Nenhum relat\u00f3rio salvo neste per\u00edodo."
    );
    refs.unansweredList.innerHTML = createEmptyState(message);
    refs.risksList.innerHTML = createEmptyState(
      "Nenhum risco detectado at\u00e9 o momento."
    );
    refs.suggestionsList.innerHTML = createEmptyState(
      "As sugest\u00f5es aparecer\u00e3o aqui quando houver dados suficientes."
    );

    refs.metaWindow.textContent = "\u00daltimas 24h";
    refs.metaMessages.textContent = "0 mensagens";
    refs.metaModel.textContent = "Aguardando";
    refs.metaGeneratedAt.textContent = "--";

    refs.healthConversations.textContent = "0 conversas";
    refs.healthMessages.textContent = "0 mensagens estimadas";
    refs.healthEngine.textContent = "Sem execu\u00e7\u00e3o";
    refs.healthEngineFoot.textContent = "Nenhum relat\u00f3rio carregado ainda.";
    refs.healthLimit.textContent = "Cobertura completa";
    refs.healthLimitFoot.textContent = "Sem truncamentos detectados.";

    refs.statConversations.textContent = "0";
    refs.statWindow.textContent = "\u00daltimas 24h";
    refs.statSatisfaction.textContent = "\u2014";
    refs.statSatisfactionLabel.textContent = "Sem dados";
    refs.statUnanswered.textContent = "0";
    refs.statUnansweredFoot.textContent = "Sem itens cr\u00edticos";
    refs.statPeakHour.textContent = "\u2014";
    refs.statPeakCount.textContent = "Sem pico detectado";

    refs.meterTrack.classList.add("is-empty");
    refs.meterPositive.style.width = "0%";
    refs.meterNeutral.style.width = "0%";
    refs.meterNegative.style.width = "0%";
    refs.meterPositiveValue.textContent = "0%";
    refs.meterNeutralValue.textContent = "0%";
    refs.meterNegativeValue.textContent = "0%";

    destroyCharts();
    state.charts.themes = createPlaceholderChart(refs.themesCanvas, "Sem dados");
    state.charts.peak = createPlaceholderChart(refs.peakCanvas, "Sem dados");
    state.charts.trend = createPlaceholderChart(
      refs.trendCanvas,
      "Sem hist\u00f3rico"
    );
  }

  function renderSummary(report) {
    refs.summaryText.textContent =
      report?.data?.summary || "Sem resumo dispon\u00edvel para este relat\u00f3rio.";
    refs.reportDateBadge.textContent = formatDateLabel(report?.reportDate);
    renderNotes(report);
    renderSatisfaction(report);
  }

  function render() {
    renderPlanCapabilities();
    renderHistory(state.reports);

    const report = getSelectedReport();

    if (!report) {
      setEmptyContent(
        "Ainda n\u00e3o h\u00e1 conversas suficientes para montar o relat\u00f3rio."
      );
      return;
    }

    renderHero(report);
    renderSummary(report);
    renderThemeList(report);
    renderStats(report);
    renderMeta(report);
    renderHealth(report);
    renderQuestions(report);
    renderRisks(report);
    renderSuggestions(report);
    renderCharts(report, buildTrendPayload());
  }

  async function loadReports(options = {}) {
    setLoading(true);

    try {
      const params = new URLSearchParams();
      params.set("days", String(state.days));
      params.set("ensure", "1");
      if (options.forceRefresh) {
        params.set("refresh", "1");
      }

      const response = await fetch(`/api/analytics/reports?${params.toString()}`, {
        credentials: "include",
      });
      const payload = await response.json();

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || "Falha ao carregar analytics.");
      }

      state.reports = Array.isArray(payload.reports) ? payload.reports : [];
      state.trend = payload?.trend || null;

      if (
        !state.selectedReportDate ||
        !state.reports.some((report) => report.reportDate === state.selectedReportDate)
      ) {
        state.selectedReportDate = state.reports[0]?.reportDate || null;
      }

      render();
    } catch (err) {
      console.error(err);
      state.reports = [];
      state.trend = null;
      state.selectedReportDate = null;
      setEmptyContent("N\u00e3o foi poss\u00edvel carregar os relat\u00f3rios de analytics.");
      showMessage("error", err?.message || "Erro ao carregar analytics.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshNow() {
    setLoading(true);

    try {
      const response = await fetch("/api/analytics/generate", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });
      const payload = await response.json();

      if (!response.ok || !payload?.ok) {
        throw new Error(
          payload?.error || "N\u00e3o foi poss\u00edvel atualizar o relat\u00f3rio."
        );
      }

      showMessage("success", "Relat\u00f3rio atualizado com as \u00faltimas 24h.");
      state.selectedReportDate =
        payload?.report?.reportDate || state.selectedReportDate;
      await loadReports({ forceRefresh: true });
    } catch (err) {
      console.error(err);
      showMessage("error", err?.message || "Erro ao atualizar o relat\u00f3rio.");
    } finally {
      setLoading(false);
    }
  }

  function exportPdf() {
    if (!access.canExportPdf) {
      refs.upgradeBanner.classList.remove("hidden");
      refs.upgradeBanner.scrollIntoView({ behavior: "smooth", block: "center" });
      showMessage("warn", "Exporta\u00e7\u00e3o em PDF dispon\u00edvel apenas no plano Pro.");
      return;
    }

    const selected = getSelectedReport();
    if (!selected?.reportDate) {
      showMessage("warn", "Nenhum relat\u00f3rio dispon\u00edvel para exportar.");
      return;
    }

    window.location.href = `/api/analytics/export.pdf?reportDate=${encodeURIComponent(
      selected.reportDate
    )}`;
  }

  function configurePlanLocks() {
    Array.from(refs.daysSelect.options).forEach((option) => {
      const value = Number(option.value);
      option.disabled = value > Number(access.maxHistoryDays || 7);
    });

    if (state.days > access.maxHistoryDays) {
      state.days = access.maxHistoryDays;
    }

    refs.daysSelect.value = String(state.days);

    if (access.canExportPdf) {
      refs.upgradeBanner.classList.add("hidden");
    } else {
      refs.upgradeBanner.classList.remove("hidden");
    }
  }

  function bindEvents() {
    refs.daysSelect.addEventListener("change", () => {
      state.days = Number(refs.daysSelect.value || 7);
      loadReports();
    });

    refs.refreshBtn.addEventListener("click", refreshNow);
    refs.exportBtn.addEventListener("click", exportPdf);
  }

  function init() {
    configurePlanLocks();
    renderPlanCapabilities();
    bindEvents();
    loadReports();
  }

  init();
})();
