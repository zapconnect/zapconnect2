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

function openAiConfigModal() {
    const modal = document.getElementById("ai-config-modal");
    if (!modal) return;

    const savedConfig = parseAiConfig(currentUser?.ai_config);
    const config = savedConfig || createEmptyAiConfig();

    // Clientes antigos não perdem a configuração que já tinham antes do novo painel.
    if (!savedConfig && String(currentUser?.prompt || "").trim()) {
        config.advancedInstructions = currentUser.prompt;
    }

    setAiConfigForm(config);
    selectAiConfigSection("identity");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("ai-config-open");
    setTimeout(() => document.getElementById("ai-assistant-name")?.focus(), 0);
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
            body: JSON.stringify({ config })
        });
        const data = await res.json();

        if (!res.ok || !data.ok) {
            throw new Error(data.error || "Não foi possível salvar a configuração.");
        }

        if (currentUser) {
            currentUser.ai_config = JSON.stringify(config);
            currentUser.prompt = data.prompt || currentUser.prompt;
        }
        window.HAS_PROMPT = String(data.prompt || "").trim().length > 10;
        renderAiConfigSummary();
        renderOnboardingChecklist();
        closeAiConfigModal();
        notify("Configuração da IA salva com sucesso.", "success");
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
    const placeholder = document.getElementById("qr-placeholder");

    if (box) {
        box.style.display = "block";
        box.classList.remove("hidden");
    }
    if (loading) loading.style.display = "none";
    if (img) img.style.display = "none";
    if (refresh) refresh.style.display = "none";
    if (timer) timer.innerText = "";
    if (placeholder) placeholder.style.display = "flex";
    clearInterval(qrTimer);
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

function renderSilenceConfig(user) {
    const toggle  = document.getElementById("silence-toggle");
    const config  = document.getElementById("silence-config");
    const selStart = document.getElementById("silence-start");
    const selEnd   = document.getElementById("silence-end");

    if (!toggle) return;

    const hassilence = user.ia_silence_start !== null && user.ia_silence_start !== undefined;

    toggle.checked = hassilence;
    if (config) config.style.display = hassilence ? "block" : "none";

    if (hassilence && selStart && selEnd) {
        selStart.value = String(user.ia_silence_start ?? 22);
        selEnd.value   = String(user.ia_silence_end   ?? 8);
    } else if (selStart && selEnd) {
        selStart.value = "22";
        selEnd.value   = "8";
    }
}

function toggleSilence() {
    const toggle = document.getElementById("silence-toggle");
    const config = document.getElementById("silence-config");
    if (config) config.style.display = toggle.checked ? "block" : "none";

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
    const name = document.getElementById("session-name").value.trim();

    if (!name) {
        notify("Informe o nome da sessão", "warning");
        return;
    }

    showQrLoading();

    const res = await fetch(API + "/sessions/create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionName: name })
    });

    const data = await res.json();

    if (data.error) {
        hideQrLoading();
        notify(data.error, "error");
        return;
    }

    notify("Sessão criada com sucesso", "success");
    listSessions();
}



// ===============================
// 📋 LISTAR SESSÕES
// ===============================
async function listSessions() {
    const res = await fetch(API + "/sessions/list", {
        credentials: "include"
    });

    const { sessions } = await res.json();

    // Cache global para goToChat verificar
    window._cachedSessions = sessions || [];
    window.SESSIONS_COUNT = window._cachedSessions.length;
    renderSessionUsage(window._cachedSessions);
    renderOnboardingChecklist();

    const box = document.getElementById("sessions-list");
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
        const isPending      = s.status === "pending";
        const isCircuitOpen  = s.status === "circuit_open";

        const badgeClass = isConnected    ? "badge-connected"
                         : isBanned      ? "badge-banned"
                         : isReauthRequired ? "badge-circuit-open"
                         : isReconnecting ? "badge-reconnecting"
                         : isCircuitOpen  ? "badge-circuit-open"
                         : isPending      ? "badge-pending"
                         : "badge-disconnected";

        const badgeLabel = isConnected    ? "Conectado"
                         : isBanned      ? "Possivel banimento"
                         : isReauthRequired ? "Autenticacao manual"
                         : isReconnecting ? "Reconectando..."
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

        div.innerHTML = `
            <div class="session-left">
                <div class="session-avatar ${isConnected ? "avatar-connected" : "avatar-offline"}">
                    <i class="fa-brands fa-whatsapp"></i>
                </div>
                <div class="session-info">
                    <div class="session-name">${s.session_name}</div>
                    <span class="session-badge ${badgeClass}">${badgeLabel}</span>
                    ${sessionNote}
                </div>
            </div>
            <div class="session-actions">
                ${!isConnected && !isBanned ? `
                <button class="btn-session-action btn-reconnect"
                    onclick="restartSession('${s.session_name}')"
                    title="Reconectar">
                    <i class="fa-solid fa-rotate"></i>
                    Reconectar
                </button>` : ""}
                <button class="btn-session-action btn-delete"
                    onclick="deleteSession('${s.session_name}')"
                    title="Apagar sessão">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;

    box.appendChild(div);
  });

  // Se alguma sessão está conectada, esconder QR/placeholder
  const hasConnected = sessions.some(s => s.status === "connected");
  if (hasConnected) hideQrUI();

  checkConnectionAlert(sessions);
}

async function restartSession(name) {
    const session = (window._cachedSessions || []).find(s => s.session_name === name);
    if (session?.status === "banned") {
        notify(
            "Esta sessao foi marcada com possivel banimento. Aguarde e procure suporte antes de tentar reconectar.",
            "warning",
            7000
        );
        return;
    }
    if (!confirm(`Reconectar a sessão "${name}"?`)) return;

    try {
        const res = await fetch(API + "/sessions/restart", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionName: name, token: currentUser?.token })
        });
        const data = await res.json();
        if (data.ok) {
            notify("Reconectando sessão...", "success");
            setTimeout(listSessions, 1500);
        } else {
            notify(data.error || "Erro ao reconectar", "error");
        }
    } catch {
        notify("Erro ao reconectar sessão", "error");
    }
}

// ===============================
// 🗑️ DELETAR
// ===============================
async function deleteSession(name) {
    if (!confirm("Apagar sessão?")) return;

    await fetch(API + "/sessions/delete", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionName: name })
    });

    listSessions();
}





// ===============================
// 📸 QR CODE — VIA SOCKET (ÚNICO E CORRETO)
// ===============================
socket.on("session:qr", ({ userId, sessionName, full }) => {
    console.log("📡 QR recebido:", full);

    if (!currentUser) return;
    if (String(userId) !== String(currentUser.id)) return;

    const box = document.getElementById("qr-preview");
    const img = document.getElementById("qr-img");
    const refresh = document.getElementById("qr-refresh");
    const timerText = document.getElementById("qr-timer");
    const placeholder = document.getElementById("qr-placeholder");

    if (!box || !img) return;

    // mostrar container
    box.classList.remove("hidden");
    box.style.display = "block";

    // esconder loading IMEDIATAMENTE
    const loading = document.getElementById("qr-loading");
    if (loading) loading.style.display = "none";
    if (placeholder) placeholder.style.display = "none";

    // mostrar imagem
    img.style.display = "block";

    // forçar reload do QR
    img.src = `/qr/${full}.png?t=${Date.now()}`;



    // botão refresh
    if (refresh) refresh.style.display = "inline-block";

    // contador visual
    let seconds = 60;
    clearInterval(qrTimer);

    if (timerText) {
        timerText.innerText = `⏳ QR expira em ${seconds}s`;

        qrTimer = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(qrTimer);
                timerText.innerText = "⚠️ QR expirado. Gere novamente.";
            } else {
                timerText.innerText = `⏳ QR expira em ${seconds}s`;
            }
        }, 1000);
    }
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



function refreshQR() {
    const img = document.getElementById("qr-img");
    if (img) {
        img.src = img.src.split("?")[0] + "?t=" + Date.now();
    }
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
        notify("Erro ao alterar o estado da IA", "error");
        checkbox.checked = !enabled;
        return;
    }

    document.getElementById("ia-status").innerText =
        enabled ? "Ativada" : "Desativada";

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

function showQrLoading() {
    const box = document.getElementById("qr-preview");
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const placeholder = document.getElementById("qr-placeholder");

    if (box) {
        box.classList.remove("hidden");
        box.style.display = "block";
    }

    if (loading) loading.style.display = "flex";
    if (img) img.style.display = "none";
    if (placeholder) placeholder.style.display = "none";
}

function showQrImage(src) {
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");
    const placeholder = document.getElementById("qr-placeholder");
    const timer = document.getElementById("qr-timer");

    if (!img) return;

    img.onload = () => {
        if (loading) loading.style.display = "none";
        if (placeholder) placeholder.style.display = "none";
        if (timer) timer.innerText = "";
        clearInterval(qrTimer);
        qrTimer = null;
        img.style.display = "block";
    };

    img.src = src;
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
