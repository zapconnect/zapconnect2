// ===============================
// 🌍 API
// ===============================
const API = window.APP_CONFIG?.API_URL || window.location.origin;
const painelBootstrapDataset = document.body?.dataset || {};

window.SESSIONS_COUNT = Number(painelBootstrapDataset.sessionsCount || 0);
window.HAS_PROMPT = String(painelBootstrapDataset.hasPrompt || "").trim() === "true";
window.FIRST_MSG_SENT = String(painelBootstrapDataset.firstMsgSent || "").trim() === "true";
window.USER_ONBOARDING_STEP = Number(painelBootstrapDataset.userOnboardingStep || 0);

// ===============================
// 🎫 VARIÁVEIS
// ===============================
let qrTimer = null;
let currentUser = null;
let activeConnectionSessionName = "";
let sessionListRequestSequence = 0;
let aiConfigScope = "";
let aiConfigBaseline = "";
let aiConfigInherited = false;
let aiConfigLinkedAgent = null;
let lastScheduleLogId = 0;
const ONBOARDING_DISMISS_KEY = "zap_onboarding_dismissed";

const AI_CONFIG_FIELDS = {
    assistantName: "ai-assistant-name",
    companyName: "ai-company-name",
    role: "ai-role",
    personalityTone: "ai-personality-tone",
    mainObjective: "ai-main-objective",
    companyContext: "ai-company-context",
    productsServices: "ai-products-services",
    faq: "ai-faq",
    additionalContext: "ai-additional-context",
    greeting: "ai-greeting",
    serviceFlow: "ai-service-flow",
    leadQualification: "ai-lead-qualification",
    commercialRules: "ai-commercial-rules",
    objections: "ai-objections",
    availability: "ai-availability",
    bookingRules: "ai-booking-rules",
    calendarInstructions: "ai-calendar-instructions",
    handoffConditions: "ai-handoff-conditions",
    handoffMessage: "ai-handoff-message",
    restrictions: "ai-restrictions",
    closing: "ai-closing",
    advancedInstructions: "ai-advanced-instructions"
};

const AI_CONFIG_AREAS = {
    identity: ["assistantName", "companyName", "role", "personalityTone"],
    objective: ["mainObjective"],
    knowledge: ["companyContext", "productsServices", "faq", "additionalContext"],
    service: ["greeting", "serviceFlow", "leadQualification"],
    sales: ["commercialRules", "objections"],
    scheduling: ["availability", "bookingRules", "calendarInstructions"],
    human: ["handoffConditions", "handoffMessage"],
    safety: ["restrictions", "closing", "advancedInstructions"]
};

function createEmptyAiConfig() {
    return Object.keys(AI_CONFIG_FIELDS).reduce((config, key) => {
        config[key] = "";
        return config;
    }, { version: 1 });
}

function parseAiConfig(rawConfig) {
    if (!rawConfig) return null;

    try {
        const parsed = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

        const config = createEmptyAiConfig();
        Object.keys(AI_CONFIG_FIELDS).forEach(key => {
            config[key] = String(parsed[key] || "");
        });
        return config;
    } catch {
        return null;
    }
}

function getAiConfigFromForm() {
    const config = createEmptyAiConfig();
    Object.entries(AI_CONFIG_FIELDS).forEach(([key, id]) => {
        config[key] = String(document.getElementById(id)?.value || "").trim();
    });
    return config;
}

function setAiConfigForm(config) {
    Object.entries(AI_CONFIG_FIELDS).forEach(([key, id]) => {
        const input = document.getElementById(id);
        if (input) input.value = String(config?.[key] || "");
    });
    updateAiConfigProgress();
}

function getFilledAiConfigAreaCount(config) {
    return Object.values(AI_CONFIG_AREAS).filter(fields =>
        fields.some(field => String(config?.[field] || "").trim())
    ).length;
}

function renderAiConfigSummary() {
    const summary = document.getElementById("ai-config-summary");
    if (!summary) return;

    const config = parseAiConfig(currentUser?.ai_config);
    if (config) {
        const filledAreas = getFilledAiConfigAreaCount(config);
        summary.textContent = filledAreas
            ? `${filledAreas} de 8 áreas configuradas. A IA já usa estas informações nos atendimentos.`
            : "A configuração foi salva, mas ainda não há informações para orientar a IA.";
        summary.classList.toggle("is-ready", filledAreas > 0);
        return;
    }

    if (String(currentUser?.prompt || "").trim()) {
        summary.textContent = "Você possui uma configuração anterior. Abra para organizá-la nas novas áreas.";
        summary.classList.add("is-ready");
        return;
    }

    summary.textContent = "Ainda não configurada. Comece pela identidade e pelo objetivo da IA.";
    summary.classList.remove("is-ready");
}

function updateAiConfigProgress() {
    const progress = document.getElementById("ai-config-progress");
    if (!progress) return;
    const filledAreas = getFilledAiConfigAreaCount(getAiConfigFromForm());
    progress.textContent = `${filledAreas} de 8 áreas preenchidas`;
}

function selectAiConfigSection(section) {
    document.querySelectorAll("[data-ai-config-section]").forEach(button => {
        const active = button.dataset.aiConfigSection === section;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    document.querySelectorAll("[data-ai-config-panel]").forEach(panel => {
        const active = panel.dataset.aiConfigPanel === section;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
    });
}

function getAiConfigSignature(config) {
    return JSON.stringify(parseAiConfig(config) || createEmptyAiConfig());
}

function updateAiConfigScopeOptions() {
    const select = document.getElementById("ai-config-scope");
    if (!select) return;

    const selected = select.value;
    select.replaceChildren(new Option("Configuração geral (todas as sessões)", ""));
    (window._cachedSessions || []).forEach(session => {
        if (!session?.session_name) return;
        select.add(new Option(`Sessão: ${session.session_name}`, session.session_name));
    });
    if ([...select.options].some(option => option.value === selected)) {
        select.value = selected;
    }
}

function updateAiConfigScopeHint(inherited, linkedAgent = null) {
    const hint = document.getElementById("ai-config-scope-hint");
    const inheritButton = document.getElementById("ai-config-inherit");
    aiConfigInherited = Boolean(inherited);
    aiConfigLinkedAgent = linkedAgent;

    if (hint) {
        hint.textContent = linkedAgent
            ? `Esta sessão usa o agente “${String(linkedAgent.name || "").slice(0, 120)}”. Ele tem prioridade nas respostas; a configuração abaixo fica como fallback.`
            : !aiConfigScope
            ? "Esta configuração vale como padrão para todas as sessões."
            : inherited
                ? "Esta sessão está herdando a configuração geral. Salvar cria uma configuração própria."
                : "Esta sessão tem uma configuração própria de IA.";
    }
    if (inheritButton) inheritButton.hidden = !aiConfigScope || aiConfigInherited;
}

async function loadAiConfigurationScope(sessionName = "") {
    const query = sessionName ? `?sessionName=${encodeURIComponent(sessionName)}` : "";
    const res = await fetch(API + "/user/ai-config" + query, { credentials: "include" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Não foi possível carregar a configuração.");

    aiConfigScope = sessionName;
    const config = parseAiConfig(data.config) || createEmptyAiConfig();
    setAiConfigForm(config);
    aiConfigBaseline = getAiConfigSignature(config);
    updateAiConfigScopeHint(data.inherited, data.linkedAgent || null);
}

async function changeAiConfigScope() {
    const select = document.getElementById("ai-config-scope");
    if (!select) return;
    const nextScope = select.value;
    const currentSignature = getAiConfigSignature(getAiConfigFromForm());
    if (currentSignature !== aiConfigBaseline && !confirm("Descartar as alterações ainda não salvas e trocar a sessão?")) {
        select.value = aiConfigScope;
        return;
    }

    select.disabled = true;
    try {
        await loadAiConfigurationScope(nextScope);
    } catch (err) {
        select.value = aiConfigScope;
        notify(err?.message || "Não foi possível carregar a configuração da sessão.", "error");
    } finally {
        select.disabled = false;
    }
}

async function inheritGlobalAiConfiguration() {
    if (!aiConfigScope) return;
    if (getAiConfigSignature(getAiConfigFromForm()) !== aiConfigBaseline &&
        !confirm("Descartar as alterações ainda não salvas e voltar à configuração geral?")) return;

    const button = document.getElementById("ai-config-inherit");
    if (button) button.disabled = true;
    try {
        const res = await fetch(API + "/user/ai-config", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionName: aiConfigScope, inheritGlobal: true })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Não foi possível restaurar a configuração geral.");
        await loadAiConfigurationScope(aiConfigScope);
        notify("A sessão voltou a usar a configuração geral.", "success");
    } catch (err) {
        notify(err?.message || "Erro ao restaurar a configuração geral.", "error");
    } finally {
        if (button) button.disabled = false;
    }
}

async function openAiConfigModal() {
    const modal = document.getElementById("ai-config-modal");
    if (!modal) return;
    updateAiConfigScopeOptions();
    const scopeSelect = document.getElementById("ai-config-scope");
    if (scopeSelect) scopeSelect.value = "";
    try {
        await loadAiConfigurationScope("");
    } catch (err) {
        notify(err?.message || "Não foi possível carregar a configuração da IA.", "error");
        return;
    }
    selectAiConfigSection("identity");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("ai-config-open");
    setTimeout(() => document.getElementById("ai-assistant-name")?.focus(), 0);
}

function updateIaAutomationUi(enabled) {
    const isEnabled = Boolean(enabled);
    const checkbox = document.getElementById("ia-toggle");
    const status = document.getElementById("ia-status");
    if (checkbox) checkbox.checked = isEnabled;
    if (status) {
        status.innerText = isEnabled ? "Ativada" : "Desativada";
        status.classList.toggle("is-enabled", isEnabled);
        status.classList.toggle("is-disabled", !isEnabled);
    }
    if (currentUser) currentUser.ia_enabled = isEnabled ? 1 : 0;
}

function closeAiConfigModal() {
    const modal = document.getElementById("ai-config-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("ai-config-open");
}

async function saveAiConfiguration(event) {
    event.preventDefault();
    const config = getAiConfigFromForm();
    const submitButton = document.querySelector("#ai-config-form button[type='submit']");
    const originalContent = submitButton?.innerHTML;

    if (!getFilledAiConfigAreaCount(config)) {
        notify("Preencha pelo menos uma área para orientar a IA.", "warning");
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
    }

    try {
        const res = await fetch(API + "/user/ai-config", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                config,
                ...(aiConfigScope ? { sessionName: aiConfigScope } : {})
            })
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
            throw new Error(data.error || "Não foi possível salvar a configuração.");
        }

        if (currentUser && !aiConfigScope) {
            currentUser.ai_config = JSON.stringify(config);
            currentUser.prompt = data.prompt || currentUser.prompt;
        }
        updateIaAutomationUi(data.ia_enabled === undefined ? true : Number(data.ia_enabled) === 1);
        aiConfigBaseline = getAiConfigSignature(config);
        updateAiConfigScopeHint(false, aiConfigLinkedAgent);
        if (!aiConfigScope) {
            window.HAS_PROMPT = String(data.prompt || "").trim().length > 10;
        }
        renderAiConfigSummary();
        renderOnboardingChecklist();
        closeAiConfigModal();
        notify("Configuração da IA salva e respostas automáticas ativadas.", "success");
    } catch (err) {
        notify(err?.message || "Erro ao salvar a configuração da IA.", "error");
    } finally {
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.innerHTML = originalContent;
        }
    }
}

function initAiConfigModal() {
    const form = document.getElementById("ai-config-form");
    if (!form) return;

    form.addEventListener("submit", saveAiConfiguration);
    form.addEventListener("input", updateAiConfigProgress);
    document.getElementById("ai-config-scope")?.addEventListener("change", changeAiConfigScope);
    document.getElementById("ai-config-inherit")?.addEventListener("click", inheritGlobalAiConfiguration);
    document.querySelectorAll("[data-ai-config-section]").forEach(button => {
        button.addEventListener("click", () => selectAiConfigSection(button.dataset.aiConfigSection));
    });
    document.querySelectorAll("[data-ai-config-close]").forEach(button => {
        button.addEventListener("click", closeAiConfigModal);
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !document.getElementById("ai-config-modal")?.hidden) {
            closeAiConfigModal();
        }
    });
}

initAiConfigModal();

// ===============================
// 🔌 SOCKET.IO
// ===============================
const socket = io(API, {
    transports: ["websocket"],
    withCredentials: true
});


// ===============================
// 🚀 INIT
// ===============================
window.onload = () => {
    initOnboardingChecklist();
    loadUser();
    loadStats();
    startScheduleLogWatcher();
};

function hideQrUI() {
    const box = document.getElementById("qr-preview");
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const refresh = document.getElementById("qr-refresh");
    const timer = document.getElementById("qr-timer");

    if (box) box.style.display = "none";
    if (loading) loading.style.display = "none";
    if (img) {
        img.style.display = "none";
        img.removeAttribute("src");
    }
    if (refresh) refresh.style.display = "none";
    if (timer) timer.innerText = "";
    clearInterval(qrTimer);
    qrTimer = null;
}

// ===============================
// 👤 USUÁRIO
// ===============================
async function loadUser() {
    const res = await fetch(API + "/auth/me", { credentials: "include" });
    if (!res.ok) return location.href = "/login";

    const { user, planConfig } = await res.json();
    currentUser = {
        ...user,
        prompt: user?.prompt || "",
        ai_config: user?.ai_config || null,
        planConfig: planConfig || null
    };
    window.HAS_PROMPT = typeof currentUser.prompt === "string" && currentUser.prompt.trim().length > 10;
    window.USER_ONBOARDING_STEP = Number(currentUser.onboarding_step || 0);
    window.FIRST_MSG_SENT = window.USER_ONBOARDING_STEP >= 4;

    renderAiConfigSummary();
    renderOnboardingChecklist();

    // Renderizar indicador de uso de IA
    renderIaUsage(currentUser);

    // Carregar configuração de silêncio
    renderSilenceConfig(currentUser);

    // 🔒 garante que QR e loading começam escondidos
    hideQrUI();

    listSessions();
}

function hideOnboardingChecklist() {
    const checklist = document.getElementById("onboarding-checklist");
    if (!checklist) return;
    checklist.hidden = true;
    checklist.style.display = "none";
}

function showOnboardingChecklist() {
    const checklist = document.getElementById("onboarding-checklist");
    if (!checklist) return;
    checklist.hidden = false;
    checklist.style.display = "";
}

function getOnboardingStepValue() {
    const value = Number(currentUser?.onboarding_step ?? window.USER_ONBOARDING_STEP ?? 0);
    return Number.isFinite(value) ? value : 0;
}

function getOnboardingSessionCount() {
    if (Array.isArray(window._cachedSessions)) {
        return window._cachedSessions.length;
    }
    const fallback = Number(window.SESSIONS_COUNT || 0);
    return Number.isFinite(fallback) ? fallback : 0;
}

function hasSavedPrompt() {
    if (typeof currentUser?.prompt === "string") {
        return currentUser.prompt.trim().length > 10;
    }
    return Boolean(window.HAS_PROMPT);
}

function getOnboardingState() {
    const onboardingStep = getOnboardingStepValue();
    const sessionCount = getOnboardingSessionCount();
    const promptReady = hasSavedPrompt();
    const firstMessageSent = onboardingStep >= 4 || Boolean(window.FIRST_MSG_SENT);
    const steps = [
        { done: true },
        { done: sessionCount > 0 },
        { done: promptReady },
        { done: firstMessageSent }
    ];
    const completedCount = steps.filter(step => step.done).length;
    const nextPendingIndex = steps.findIndex(step => !step.done);

    return {
        onboardingStep,
        sessionCount,
        completedCount,
        nextPendingIndex,
        shouldShow: sessionCount === 0 || onboardingStep < 4,
        steps
    };
}

function renderOnboardingChecklist() {
    const checklist = document.getElementById("onboarding-checklist");
    if (!checklist) return;

    if (localStorage.getItem(ONBOARDING_DISMISS_KEY) === "1") {
        hideOnboardingChecklist();
        return;
    }

    const state = getOnboardingState();
    if (!state.shouldShow) {
        hideOnboardingChecklist();
        return;
    }

    showOnboardingChecklist();

    const progressLabel = document.getElementById("onboarding-progress-label");
    const progressHint = document.getElementById("onboarding-progress-hint");
    const progressBar = document.getElementById("onboarding-bar");
    const progressPct = Math.max(10, Math.round((state.completedCount / 4) * 100));

    if (progressLabel) {
        progressLabel.textContent = `${state.completedCount} de 4 concluidos`;
    }

    if (progressHint) {
        progressHint.textContent = state.completedCount >= 4
            ? "Tudo pronto para operar."
            : state.nextPendingIndex >= 0
                ? `Proximo foco: passo ${state.nextPendingIndex + 1}.`
                : "Checklist em andamento";
    }

    if (progressBar) {
        progressBar.style.width = `${progressPct}%`;
    }

    document.querySelectorAll("#onboarding-steps .onboarding-step-card").forEach(card => {
        const index = Number(card.getAttribute("data-step-index") || 0) - 1;
        const step = state.steps[index];
        if (!step) return;

        card.classList.remove("step-done", "step-active", "step-pending");

        let statusText = "Pendente";
        let statusClass = "step-pending";

        if (step.done) {
            statusText = "Concluido";
            statusClass = "step-done";
        } else if (index === state.nextPendingIndex) {
            statusText = "Em andamento";
            statusClass = "step-active";
        }

        card.classList.add(statusClass);
        const statusEl = card.querySelector("[data-step-status]");
        if (statusEl) {
            statusEl.textContent = statusText;
        }
    });
}

function initOnboardingChecklist() {
    const checklist = document.getElementById("onboarding-checklist");
    if (!checklist) return;

    const dismissButton = document.getElementById("onboarding-dismiss");
    if (dismissButton && !dismissButton.dataset.bound) {
        dismissButton.dataset.bound = "1";
        dismissButton.addEventListener("click", () => {
            localStorage.setItem(ONBOARDING_DISMISS_KEY, "1");
            hideOnboardingChecklist();
        });
    }

    renderOnboardingChecklist();
}

// ===============================
// 🤖 INDICADOR DE USO DA IA
// ===============================
function getPlanLabel(user) {
    const rawLabel = String(user?.planConfig?.displayName || user?.plan || "Starter").trim();
    return rawLabel || "Starter";
}

function resolveIaLimit(user) {
    const LIMITS = { free: 500, starter: 500, pro: null };
    const used = Number(user.ia_messages_used) || 0;
    const plan = String(user?.plan || "free").trim().toLowerCase();
    const rawLimit = user?.planConfig?.maxIaMessages;
    const normalizedRawLimit = String(rawLimit ?? "").trim().toLowerCase();
    const fallbackLimit = Object.prototype.hasOwnProperty.call(LIMITS, plan)
        ? LIMITS[plan]
        : null;
    const numericLimit = Number(rawLimit);
    const limit = normalizedRawLimit === "unlimited"
        ? null
        : Number.isFinite(numericLimit) && numericLimit >= 0
            ? numericLimit
            : fallbackLimit;

    return { used, limit };
}

function getUsageBarClass(pct, unlimited = false) {
    if (unlimited) return "bar-unlimited";
    if (pct >= 90) return "bar-danger";
    if (pct >= 70) return "bar-warning";
    return "bar-ok";
}

function getResetInfo(resetAt) {
    const resetValue = Number(resetAt);
    if (!Number.isFinite(resetValue) || resetValue <= 0) {
        return {
            short: "Ciclo mensal comeca no primeiro envio",
            summary: "ciclo mensal ainda nao iniciado",
        };
    }

    const now = Date.now();
    const diff = resetValue - now;
    const dateLabel = new Date(resetValue).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
    });

    if (diff <= 0) {
        return {
            short: `Renova hoje (${dateLabel})`,
            summary: "renova hoje",
        };
    }

    const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
    if (days <= 1) {
        return {
            short: `Renova amanha (${dateLabel})`,
            summary: "renova amanha",
        };
    }

    return {
        short: `Renova em ${days} dias (${dateLabel})`,
        summary: `renova em ${days} dias`,
    };
}

function renderIaUsage(user) {
    const wrap = document.getElementById("ia-usage-wrap");
    const card = document.getElementById("plan-usage-card");
    const countEl = document.getElementById("ia-usage-count");
    const barEl = document.getElementById("ia-progress-bar");
    const remaining = document.getElementById("ia-usage-remaining");
    const renewalEl = document.getElementById("ia-usage-renewal");
    const planPill = document.getElementById("plan-usage-pill");
    const planLink = document.getElementById("plan-usage-link");
    const summaryEl = document.getElementById("plan-usage-summary");
    const statValue = document.getElementById("stat-ia");
    const statMeta = document.getElementById("stat-ia-meta");

    if (!wrap || !countEl || !barEl || !remaining || !renewalEl) return;

    const planLabel = getPlanLabel(user);
    const { used, limit } = resolveIaLimit(user);

    if (card) card.style.display = "block";
    if (planPill) planPill.textContent = `Plano ${planLabel}`;
    if (planLink) {
        planLink.textContent = limit === null ? "Gerenciar plano" : "Fazer upgrade";
    }

    wrap.style.display = "block";
    remaining.style.color = "";
    renewalEl.style.color = "";

    if (limit === null) {
        countEl.textContent = `${used} / ilimitado`;
        barEl.style.width = "100%";
        barEl.className = `ia-progress-bar ${getUsageBarClass(100, true)}`;
        remaining.textContent = "IA ilimitada liberada neste plano";
        renewalEl.textContent = "Sem bloqueio mensal de mensagens";

        if (summaryEl) {
            summaryEl.textContent = `Plano ${planLabel} com IA ilimitada e acompanhamento das sessoes ativas.`;
        }
        if (statValue) statValue.textContent = String(used);
        if (statMeta) statMeta.textContent = `Plano ${planLabel} - ilimitado`;
        return;
    }

    const safeLimit = limit > 0 ? limit : 1;
    const pct = Math.min(100, Math.round((used / safeLimit) * 100));
    const left = Math.max(0, limit - used);
    const resetInfo = getResetInfo(user?.ia_messages_reset_at);
    const barClass = getUsageBarClass(pct);

    countEl.textContent = `${used} / ${limit}`;
    barEl.style.width = `${pct}%`;
    barEl.className = `ia-progress-bar ${barClass}`;

    remaining.textContent = left > 0
        ? `${pct}% usado - ${left} restante(s)`
        : "Limite mensal atingido";
    renewalEl.textContent = resetInfo.short;

    if (left === 0) {
        remaining.style.color = "#fca5a5";
        renewalEl.style.color = "#f2c94c";
    } else if (pct >= 90) {
        remaining.style.color = "#f2c94c";
    }

    if (summaryEl) {
        summaryEl.textContent = `${pct}% da franquia de IA usada, ${resetInfo.summary}.`;
    }
    if (statValue) statValue.textContent = `${used} / ${limit}`;
    if (statMeta) statMeta.textContent = `${pct}% usado - ${resetInfo.summary}`;
}

function renderSessionUsage(sessions = []) {
    if (!currentUser) return;

    const wrap = document.getElementById("session-usage-wrap");
    const countEl = document.getElementById("session-usage-count");
    const barEl = document.getElementById("session-progress-bar");
    const remaining = document.getElementById("session-usage-remaining");
    const statusEl = document.getElementById("session-usage-status");

    if (!wrap || !countEl || !barEl || !remaining || !statusEl) return;

    const limitRaw = Number(currentUser?.planConfig?.maxSessions);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 1;
    const used = Array.isArray(sessions) ? sessions.length : 0;
    const connected = Array.isArray(sessions)
        ? sessions.filter((session) => session?.status === "connected").length
        : 0;
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const left = Math.max(0, limit - used);

    wrap.style.display = "block";
    countEl.textContent = `${used} / ${limit}`;
    barEl.style.width = `${pct}%`;
    barEl.className = `ia-progress-bar ${getUsageBarClass(pct)}`;

    remaining.textContent = left > 0
        ? `${left} vaga(s) restante(s)`
        : "Limite de sessoes atingido";

    if (!used) {
        statusEl.textContent = "Nenhuma sessao criada ainda";
    } else if (!connected) {
        statusEl.textContent = "Nenhuma sessao conectada agora";
    } else {
        statusEl.textContent = `${connected} conectada(s) agora`;
    }

    remaining.style.color = left === 0 ? "#fca5a5" : "";
}

function setSilenceStatus(message, state = "inactive") {
    const status = document.getElementById("silence-status");
    if (!status) return;

    status.textContent = message;
    status.classList.toggle("is-active", state === "active");
    status.classList.toggle("is-pending", state === "pending");
    status.classList.toggle("is-inactive", state === "inactive");
}

function renderSilenceConfig(user) {
    const toggle  = document.getElementById("silence-toggle");
    const config  = document.getElementById("silence-config");
    const selStart = document.getElementById("silence-start");
    const selEnd   = document.getElementById("silence-end");

    if (!toggle) return;

    const hassilence = user.ia_silence_start !== null && user.ia_silence_start !== undefined;

    toggle.checked = hassilence;
    if (config) config.style.display = hassilence ? "flex" : "none";

    if (hassilence && selStart && selEnd) {
        selStart.value = String(user.ia_silence_start ?? 22);
        selEnd.value   = String(user.ia_silence_end   ?? 8);
    } else if (selStart && selEnd) {
        selStart.value = "22";
        selEnd.value   = "8";
    }

    if (hassilence && selStart && selEnd) {
        const formatHour = value => `${String(value).padStart(2, "0")}:00`;
        setSilenceStatus(`Ativo · ${formatHour(selStart.value)}–${formatHour(selEnd.value)}`, "active");
    } else {
        setSilenceStatus("Desativado", "inactive");
    }
}

function toggleSilence() {
    const toggle = document.getElementById("silence-toggle");
    const config = document.getElementById("silence-config");
    if (!toggle) return;
    if (config) config.style.display = toggle.checked ? "flex" : "none";
    setSilenceStatus(toggle.checked ? "Defina o intervalo" : "Desativado", toggle.checked ? "pending" : "inactive");

    if (!toggle.checked) {
        // Desativar silêncio imediatamente
        fetch(API + "/user/ia-silence", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: false })
        }).then(() => notify("Horário de silêncio desativado", "success"));
    }
}

async function saveSilence() {
    const start = Number(document.getElementById("silence-start")?.value);
    const end   = Number(document.getElementById("silence-end")?.value);

    try {
        const res = await fetch(API + "/user/ia-silence", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: true, start, end })
        });

        const data = await res.json();
        if (data.ok) {
            const fmt = h => String(h).padStart(2,"0") + ":00";
            setSilenceStatus(`Ativo · ${fmt(start)}–${fmt(end)}`, "active");
            notify(`Silêncio ativo: ${fmt(start)} – ${fmt(end)} ✅`, "success");
        } else {
            notify(data.error || "Erro ao salvar", "error");
        }
    } catch {
        notify("Erro ao salvar horário de silêncio", "error");
    }
}

// ===============================
// 📊 MÉTRICAS DO PAINEL
// ===============================
function setStatSkeleton(active) {
    document.querySelectorAll(".stat-card").forEach(card => {
        card.classList.toggle("skeleton", !!active);
    });
}

async function loadStats() {
    setStatSkeleton(true);
    try {
        const res = await fetch(API + "/api/painel/stats", { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();

        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val ?? "0";
        };

        set("stat-sessions",     data.sessionsAtivas);
        set("stat-clientes",     data.totalClientes);
        set("stat-agendamentos", data.agendamentos);
        if (!currentUser) {
            set("stat-ia", data.iaUsado);
        } else {
            renderIaUsage(currentUser);
        }

    } catch (err) {
        console.warn("Erro ao carregar stats:", err);
        // Mostrar 0 em caso de erro
        const ids = currentUser
            ? ["stat-sessions", "stat-clientes", "stat-agendamentos"]
            : ["stat-sessions", "stat-clientes", "stat-agendamentos", "stat-ia"];
        ids
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = "0"; });
        const statMeta = document.getElementById("stat-ia-meta");
        if (currentUser) {
            renderIaUsage(currentUser);
        } else if (statMeta) {
            statMeta.textContent = "Nao foi possivel carregar o limite";
        }
    } finally {
        setStatSkeleton(false);
    }
}

// ===============================
// 🚪 LOGOUT (CORRETO)
// ===============================
async function logout() {
    try {
        await fetch(API + "/auth/logout", {
            method: "POST",
            credentials: "include"
        });

        localStorage.clear();
        sessionStorage.clear();

        notify("Logout realizado com sucesso", "success");
        setTimeout(() => {
            window.location.href = "/login";
        }, 800);

    } catch (err) {
        console.error("Erro ao sair:", err);
        notify("Erro ao sair da conta", "error");
    }
}


// ===============================
// 📱 CRIAR SESSÃO
// ===============================
async function createSession() {
    const input = document.getElementById("session-name");
    const button = document.getElementById("session-create-btn");
    const name = input?.value.trim() || "";

    if (!name) {
        notify("Informe um nome para identificar esta conexão", "warning");
        input?.focus();
        return;
    }

    activeConnectionSessionName = name;
    showQrLoading(name);
    if (button) button.disabled = true;

    try {
        const res = await fetch(API + "/sessions/create", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionName: name })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.error) {
            setConnectionStatus("error", data.error || "Não foi possível iniciar a conexão. Tente novamente.");
            const loading = document.getElementById("qr-loading");
            if (loading) loading.style.display = "none";
            notify(data.error || "Não foi possível iniciar a conexão", "error");
            return;
        }

        notify("Sessão criada. Agora conecte pelo QR Code.", "success");
        if (input) input.value = "";
        await listSessions();
    } catch (err) {
        setConnectionStatus("error", "Não foi possível iniciar a conexão. Verifique sua internet e tente novamente.");
        const loading = document.getElementById("qr-loading");
        if (loading) loading.style.display = "none";
        notify("Erro ao iniciar a conexão do WhatsApp", "error");
    } finally {
        if (button) button.disabled = false;
    }
}



// ===============================
// 📋 LISTAR SESSÕES
// ===============================
async function listSessions() {
    const requestSequence = ++sessionListRequestSequence;
    const res = await fetch(API + "/sessions/list", { credentials: "include" });
    if (!res.ok) throw new Error("Não foi possível carregar as conexões do WhatsApp.");
    const payload = await res.json();
    if (requestSequence !== sessionListRequestSequence) return;
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

    // Cache global para goToChat verificar
    window._cachedSessions = sessions || [];
    updateAiConfigScopeOptions();
    window.SESSIONS_COUNT = window._cachedSessions.length;
    renderSessionUsage(window._cachedSessions);
    renderOnboardingChecklist();

    const box = document.getElementById("sessions-list");
    if (!box) return;
    box.innerHTML = "";

  if (!sessions.length) {
    box.innerHTML = `
            <div class="session-empty">
                <div class="session-illust">📱</div>
                <h3>Conecte seu primeiro WhatsApp</h3>
                <p>Crie uma sessão, escaneie o QR Code e comece a atender clientes pelo painel.</p>
                <button class="btn btn-accent" onclick="scrollToCreateSession()">
                  <i class="fa-solid fa-qrcode"></i>
                  Criar sessão agora
                </button>
            </div>`;
    checkConnectionAlert(sessions);
    return;
  }

  sessions.forEach(s => {
    const isConnected    = s.status === "connected";
        const isBanned      = s.status === "banned";
        const isReauthRequired = s.status === "reauth_required";
        const isReconnecting = s.status === "reconnecting";
        const isConnecting   = s.status === "connecting";
        const isPending      = s.status === "pending";
        const isCircuitOpen  = s.status === "circuit_open";

        const badgeClass = isConnected    ? "badge-connected"
                         : isBanned      ? "badge-banned"
                         : isReauthRequired ? "badge-circuit-open"
                         : isReconnecting ? "badge-reconnecting"
                         : isConnecting  ? "badge-reconnecting"
                         : isCircuitOpen  ? "badge-circuit-open"
                         : isPending      ? "badge-pending"
                         : "badge-disconnected";

        const badgeLabel = isConnected    ? "Conectado"
                         : isBanned      ? "Possivel banimento"
                         : isReauthRequired ? "Autenticacao manual"
                         : isReconnecting ? "Reconectando..."
                         : isConnecting  ? "Conectando..."
                         : isCircuitOpen  ? "Ação necessária"
                         : isPending      ? "Aguardando QR"
                         : "Desconectado";

        const sessionNote = isBanned
                         ? `<div class="session-note session-note-warning">Reconexao automatica pausada. Aguarde e procure suporte antes de autenticar novamente.</div>`
                         : isReauthRequired
                         ? `<div class="session-note session-note-warning">A restauracao automatica foi interrompida para evitar loop. Clique em Reconectar quando quiser gerar um novo QR.</div>`
                         : "";

        const div = document.createElement("div");
        div.className = "session-card";
        const sessionNameText = escapeSessionHtml(s.session_name);
        const sessionNameArg = escapeSessionHtml(
            JSON.stringify(String(s.session_name || ""))
                .replace(/</g, "\\u003c")
                .replace(/\u2028/g, "\\u2028")
                .replace(/\u2029/g, "\\u2029")
        );

        div.innerHTML = `
            <div class="session-left">
                <div class="session-avatar ${isConnected ? "avatar-connected" : "avatar-offline"}">
                    <i class="fa-brands fa-whatsapp"></i>
                </div>
                <div class="session-info">
                    <div class="session-name">${sessionNameText}</div>
                    <span class="session-badge ${badgeClass}">${badgeLabel}</span>
                    ${sessionNote}
                </div>
            </div>
            <div class="session-actions">
                ${isPending ? `
                <button class="btn-session-action btn-reconnect"
                    onclick="showSessionQr(${sessionNameArg})"
                    title="Abrir QR Code desta conexão">
                    <i class="fa-solid fa-qrcode"></i>
                    Abrir QR
                </button>` : !isConnected && !isBanned && !isConnecting ? `
                <button class="btn-session-action btn-reconnect"
                    onclick="restartSession(${sessionNameArg})"
                    title="Reconectar">
                    <i class="fa-solid fa-rotate"></i>
                    Reconectar
                </button>` : ""}
                <button class="btn-session-action btn-delete"
                    onclick="deleteSession(${sessionNameArg})"
                    title="Apagar sessão">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;

    box.appendChild(div);
  });

  if (activeConnectionSessionName) {
      const activeSession = sessions.find(s => s.session_name === activeConnectionSessionName);
      if (!activeSession) {
          activeConnectionSessionName = "";
          hideQrUI();
      } else if (activeSession.status === "connected") {
          showConnectionSuccess(activeSession.session_name);
      } else if (["disconnected", "reauth_required", "circuit_open"].includes(activeSession.status)) {
          showConnectionInterrupted(activeSession.session_name);
      } else if (["reconnecting", "connecting"].includes(activeSession.status)) {
          setConnectionStatus("info", "Reconectando ao WhatsApp. Aguarde a atualização do status.");
      } else if (activeSession.status === "pending") {
          setConnectionStatus("info", "Aguardando leitura do QR Code do WhatsApp.");
      }
  }

  checkConnectionAlert(sessions);
}

function escapeSessionHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function restartSession(name, options = {}) {
    const session = (window._cachedSessions || []).find(s => s.session_name === name);
    if (session?.status === "banned") {
        notify(
            "Esta sessao foi marcada com possivel banimento. Aguarde e procure suporte antes de tentar reconectar.",
            "warning",
            7000
        );
        return;
    }
    if (!options.skipConfirm && !confirm(`Reconectar a sessão "${name}"?`)) return;

    try {
        activeConnectionSessionName = name;
        showQrLoading(name);
        const res = await fetch(API + "/sessions/restart", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionName: name, refreshOnly: Boolean(options.skipConfirm) })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
            notify("Reconectando sessão...", "success");
            setTimeout(() => listSessions().catch(() => {}), 1500);
        } else {
            setConnectionStatus("error", data.error || "Não foi possível reiniciar a conexão.");
            document.getElementById("qr-loading")?.style.setProperty("display", "none");
            notify(data.error || "Erro ao reconectar", "error");
        }
    } catch {
        setConnectionStatus("error", "Não foi possível reiniciar a conexão. Tente novamente.");
        document.getElementById("qr-loading")?.style.setProperty("display", "none");
        notify("Erro ao reconectar sessão", "error");
    }
}

// ===============================
// 🗑️ DELETAR
// ===============================
async function deleteSession(name) {
    if (!confirm("Apagar sessão?")) return;

    try {
        const res = await fetch(API + "/sessions/delete", {
            method: "DELETE",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionName: name })
        });
        if (!res.ok) throw new Error("Não foi possível excluir a sessão.");
        if (activeConnectionSessionName === name) {
            activeConnectionSessionName = "";
            hideQrUI();
        }
        await listSessions();
    } catch {
        notify("Não foi possível apagar a sessão", "error");
    }
}





// ===============================
// 📸 QR CODE — VIA SOCKET (ÚNICO E CORRETO)
// ===============================
socket.on("session:qr", ({ userId, sessionName }) => {
    if (!currentUser) return;
    if (String(userId) !== String(currentUser.id)) return;
    if (!sessionName) return;
    if (activeConnectionSessionName && activeConnectionSessionName !== sessionName) return;
    activeConnectionSessionName = sessionName;

    const box = document.getElementById("qr-preview");
    const img = document.getElementById("qr-img");
    const refresh = document.getElementById("qr-refresh");
    const timerText = document.getElementById("qr-timer");
    const sessionLabel = document.getElementById("qr-session-label");

    if (!box || !img) return;

    box.style.display = "block";
    if (sessionLabel) sessionLabel.textContent = `Conectando: ${sessionName}`;
    setConnectionStatus("info", "Leia este QR Code com o WhatsApp do celular que deseja conectar.");

    const loading = document.getElementById("qr-loading");
    if (loading) loading.style.display = "none";
    img.style.display = "block";
    const qrFile = `USER${currentUser.id}_${sessionName}.png`;
    img.onload = () => {
        if (activeConnectionSessionName !== sessionName) return;
        setConnectionStatus("info", "Leia este QR Code com o WhatsApp do celular que deseja conectar.");
    };
    img.onerror = () => {
        if (activeConnectionSessionName !== sessionName) return;
        img.style.display = "none";
        setConnectionStatus("warning", "Não foi possível carregar o QR Code. Aguarde alguns segundos ou abra o QR novamente.");
    };
    img.src = `/qr/${encodeURIComponent(qrFile)}?t=${Date.now()}`;

    let seconds = 60;
    clearInterval(qrTimer);

    if (timerText) {
        timerText.innerText = `QR Code temporário · expira em ${seconds}s`;

        qrTimer = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(qrTimer);
                qrTimer = null;
                timerText.innerText = "Este QR Code expirou. Gere outro para continuar.";
                setConnectionStatus("warning", "O código expirou antes do pareamento.");
                if (refresh) refresh.style.display = "inline-flex";
            } else {
                timerText.innerText = `QR Code temporário · expira em ${seconds}s`;
            }
        }, 1000);
    }
});

socket.on("session:stateChange", ({ userId, sessionName, state }) => {
    if (!currentUser || String(userId) !== String(currentUser.id)) return;
    if (!sessionName || sessionName !== activeConnectionSessionName) return;

    const connectionState = window.ZapConnectSessionState?.classify(state) || "unknown";
    if (connectionState === "disconnected") {
        showConnectionInterrupted(sessionName);
        listSessions().catch(() => {});
    } else if (connectionState === "connected") {
        showConnectionSuccess(sessionName);
        listSessions().catch(() => {});
    } else if (connectionState === "connecting") {
        setConnectionStatus("info", "QR lido. Finalizando a conexão com o WhatsApp…");
    } else if (connectionState === "qr") {
        setConnectionStatus("info", "QR pronto. Leia o código com o WhatsApp do celular.");
    }
});

socket.on("server:online", ({ userId }) => {
    if (!currentUser || String(userId) !== String(currentUser.id)) return;
    listSessions().catch(() => {});
});

socket.on("server:offline", ({ userId }) => {
    if (!currentUser || String(userId) !== String(currentUser.id)) return;
    listSessions().catch(() => {});
});

socket.on("sessions:changed", ({ userId }) => {
    if (!currentUser) return;
    if (String(userId) !== String(currentUser.id)) return;
    listSessions().catch(() => {});
});

socket.on("onboarding:step", ({ step }) => {
    const nextStep = Number(step || 0);
    if (!Number.isFinite(nextStep) || nextStep <= 0) return;

    window.USER_ONBOARDING_STEP = Math.max(Number(window.USER_ONBOARDING_STEP || 0), nextStep);
    window.FIRST_MSG_SENT = Number(window.USER_ONBOARDING_STEP || 0) >= 4;

    if (currentUser) {
        currentUser.onboarding_step = Number(window.USER_ONBOARDING_STEP || 0);
    }

    renderOnboardingChecklist();
});

socket.on("session:circuitOpen", ({ userId, sessionName, attempts }) => {
    if (!currentUser) return;
    if (String(userId) !== String(currentUser.id)) return;

    notify(
        `A sessão "${sessionName}" parou a reconexão automática após ${attempts} tentativa(s). Reinicie ou recrie a sessão.`,
        "warning",
        7000
    );
    listSessions().catch(() => {});
});

socket.on("session:banned", ({ userId, message }) => {
    if (!currentUser) return;
    if (String(userId) !== String(currentUser.id)) return;

    notify(
        message || "Possivel banimento detectado na sessao. A reconexao automatica foi pausada.",
        "warning",
        9000
    );
    listSessions().catch(() => {});
});

socket.on("session:reauthRequired", ({ userId, message }) => {
    if (!currentUser) return;
    if (String(userId) !== String(currentUser.id)) return;

    notify(
        message || "A sessao precisa de autenticacao manual. A recuperacao automatica foi interrompida para evitar loop.",
        "warning",
        9000
    );
    listSessions().catch(() => {});
});



async function refreshQR() {
    if (!activeConnectionSessionName) {
        notify("Selecione uma conexão para gerar outro QR Code", "warning");
        return;
    }
    const session = (window._cachedSessions || []).find(item => item.session_name === activeConnectionSessionName);
    if (!session || session.status === "connected") {
        notify("Esta conexão já está ativa ou não está mais disponível", "warning");
        return;
    }
    if (session.status !== "pending") {
        notify("Para reconectar esta sessão, use o botão Reconectar na lista de sessões.", "warning");
        return;
    }
    const refresh = document.getElementById("qr-refresh");
    if (refresh) refresh.disabled = true;
    await restartSession(activeConnectionSessionName, { skipConfirm: true });
    if (refresh) refresh.disabled = false;
}

// ===============================
// 🤖 IA
// ===============================
async function toggleIA() {
    const checkbox = document.getElementById("ia-toggle");
    const enabled = checkbox.checked;

    const res = await fetch(API + "/user/toggle-ia", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
    });

    const data = await res.json();

    if (!data.ok) {
        notify(data.error || "Erro ao alterar o estado da IA", "warning");
        checkbox.checked = !enabled;
        return;
    }

    updateIaAutomationUi(enabled);

    notify(
        enabled ? "IA ativada com sucesso" : "IA desativada",
        "success"
    );
}


// ===============================
// 🌐 STATUS AUTOMÁTICO (CORRETO)
// ===============================
socket.on("connect", () => {
    console.log("🟢 Socket conectado");
    setOnlineStatus(true);
});

socket.on("disconnect", () => {
    console.log("🔴 Socket desconectado");
    setOnlineStatus(false);
});



function setOnlineStatus(isOnline) {
    const dot = document.getElementById("status-dot");
    const text = document.getElementById("status-text");

    if (!dot || !text) return;

    if (isOnline) {
        dot.classList.remove("status-offline");
        dot.classList.add("status-online");
        text.innerText = "Online";
    } else {
        dot.classList.remove("status-online");
        dot.classList.add("status-offline");
        text.innerText = "Offline";
    }
}

function showQrLoading(sessionName = activeConnectionSessionName) {
    const box = document.getElementById("qr-preview");
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const refresh = document.getElementById("qr-refresh");
    const timer = document.getElementById("qr-timer");

    if (box) {
        box.style.display = "block";
    }

    if (loading) loading.style.display = "flex";
    if (img) img.style.display = "none";
    if (refresh) refresh.style.display = "none";
    if (timer) timer.textContent = "";
    clearInterval(qrTimer);
    qrTimer = null;
    if (sessionName) activeConnectionSessionName = sessionName;
    setConnectionStatus("info", "Preparando a conexão segura com o WhatsApp…");
    const sessionLabel = document.getElementById("qr-session-label");
    if (sessionLabel && activeConnectionSessionName) {
        sessionLabel.textContent = `Conectando: ${activeConnectionSessionName}`;
    }
}

function showQrImage(src) {
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const timer = document.getElementById("qr-timer");

    if (!img) return;

    img.onload = () => {
        if (loading) loading.style.display = "none";
        if (timer) timer.innerText = "";
        clearInterval(qrTimer);
        qrTimer = null;
        img.style.display = "block";
    };

    img.src = src;
}

function setConnectionStatus(state, message) {
    const status = document.getElementById("connection-status");
    if (!status) return;
    status.className = `connection-status connection-status--${state}`;
    status.textContent = message;
}

function showConnectionSuccess(sessionName) {
    const box = document.getElementById("qr-preview");
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const refresh = document.getElementById("qr-refresh");
    const timer = document.getElementById("qr-timer");
    const label = document.getElementById("qr-session-label");
    if (box) box.style.display = "block";
    if (loading) loading.style.display = "none";
    if (img) {
        img.style.display = "none";
        img.removeAttribute("src");
    }
    if (refresh) refresh.style.display = "none";
    if (timer) timer.textContent = "";
    if (label) label.textContent = `Conectado: ${sessionName}`;
    clearInterval(qrTimer);
    qrTimer = null;
    setConnectionStatus("success", "WhatsApp conectado. Sua sessão já pode receber atendimentos pelo ZapConnect.");
}

function showConnectionInterrupted(sessionName) {
    const box = document.getElementById("qr-preview");
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const refresh = document.getElementById("qr-refresh");
    const timer = document.getElementById("qr-timer");
    const label = document.getElementById("qr-session-label");
    if (box) box.style.display = "block";
    if (loading) loading.style.display = "none";
    if (img) {
        img.style.display = "none";
        img.removeAttribute("src");
    }
    if (refresh) refresh.style.display = "none";
    if (timer) timer.textContent = "Use “Reconectar” na lista de sessões para tentar novamente.";
    if (label) label.textContent = `Conexão: ${sessionName}`;
    clearInterval(qrTimer);
    qrTimer = null;
    setConnectionStatus("warning", "A conexão foi interrompida. Use Reconectar na lista de sessões para tentar novamente.");
}

function showSessionQr(sessionName) {
    const session = (window._cachedSessions || []).find(item => item.session_name === sessionName);
    if (!session || session.status === "connected") return;

    activeConnectionSessionName = sessionName;
    showQrLoading(sessionName);
    const img = document.getElementById("qr-img");
    if (!img || !currentUser) return;

    img.onload = () => {
        if (activeConnectionSessionName !== sessionName) return;
        const loading = document.getElementById("qr-loading");
        const refresh = document.getElementById("qr-refresh");
        const timer = document.getElementById("qr-timer");
        if (loading) loading.style.display = "none";
        if (refresh) refresh.style.display = "inline-flex";
        if (timer) timer.textContent = "Se o código não for aceito, gere outro QR Code.";
        img.style.display = "block";
        setConnectionStatus("info", "Leia este QR Code com o WhatsApp do celular que deseja conectar.");
    };
    img.onerror = () => {
        if (activeConnectionSessionName !== sessionName) return;
        const loading = document.getElementById("qr-loading");
        if (loading) loading.style.display = "none";
        setConnectionStatus("info", "Aguardando o QR Code. Ele aparecerá automaticamente quando estiver pronto.");
    };
    const qrFile = `USER${currentUser.id}_${sessionName}.png`;
    img.src = `/qr/${encodeURIComponent(qrFile)}?t=${Date.now()}`;
}
function hideQrLoading() {
    const loading = document.getElementById("qr-loading");
    const placeholder = document.getElementById("qr-placeholder");
    const box = document.getElementById("qr-preview");
    const img = document.getElementById("qr-img");
    const timer = document.getElementById("qr-timer");
    clearInterval(qrTimer);
    qrTimer = null;
    if (loading) loading.style.display = "none";
    if (placeholder) placeholder.style.display = "none";
    if (img) img.style.display = "none";
    if (box) box.style.display = "none";
    if (timer) timer.innerText = "";
}

// ===============================
// 🔔 ALERTAS DE AGENDAMENTO (PAINEL)
// ===============================
async function pollScheduleLogs() {
    try {
        const res = await fetch(`${API}/api/agendamentos/logs?after=${lastScheduleLogId}`, {
            credentials: "include"
        });
        if (!res.ok) return;

        const data = await res.json();
        const logs = Array.isArray(data.logs) ? data.logs : [];

        logs.forEach(log => {
            const id = Number(log.id) || 0;
            if (id > lastScheduleLogId) lastScheduleLogId = id;

            const success = Number(log.success_count) || 0;
            const failure = Number(log.failure_count) || 0;
            const sentAt = log.sent_at ? new Date(Number(log.sent_at)).toLocaleString("pt-BR") : "";
            const type = failure > 0 ? "warning" : "success";
            const msg = `Agendamento #${log.schedule_id} concluído: ${success} sucesso(s), ${failure} falha(s)${sentAt ? " — " + sentAt : ""}`;

            notify(msg, type, 6000);
        });
    } catch (err) {
        console.warn("Erro ao buscar logs de agendamento", err);
    }
}

function startScheduleLogWatcher() {
    pollScheduleLogs();
    setInterval(pollScheduleLogs, 15000);
}

// ===============================
// 📱 Helpers de navegação no painel
// ===============================
function scrollToCreateSession() {
    const input = document.getElementById("session-name");
    if (input) {
        input.scrollIntoView({ behavior: "smooth", block: "center" });
        input.focus();
    }
}
/* ===============================
   🔔 NOTIFICAÇÕES (TOAST)
================================ */

(function createToastContainer() {
    if (document.getElementById("toast-container")) return;
    const div = document.createElement("div");
    div.id = "toast-container";
    div.className = "toast-container";
    document.body.appendChild(div);
})();

function notify(message, type = "success", timeout = 3500) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;

    const icon =
        type === "success" ? "fa-circle-check" :
            type === "error" ? "fa-circle-xmark" :
                type === "warning" ? "fa-triangle-exclamation" :
                    "fa-circle-info";

    toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <div class="content">${message}</div>
  `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-6px)";
        setTimeout(() => toast.remove(), 300);
    }, timeout);
}
function checkConnectionAlert(sessions) {

    const alert = document.getElementById("connect-alert");

    if (!sessions || sessions.length === 0) {
        alert.classList.remove("hidden");
        return;
    }

    const connected = sessions.some(s => s.status === "connected");

    if (!connected) {
        alert.classList.remove("hidden");
    } else {
        alert.classList.add("hidden");
    }
}
