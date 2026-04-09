// ===============================
// 🌍 API
// ===============================
const API = window.APP_CONFIG?.API_URL || window.location.origin;

// ===============================
// 🎫 VARIÁVEIS
// ===============================
let qrTimer = null;
let currentUser = null;
let lastScheduleLogId = 0;

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
    if (img) img.style.display = "none";
    if (refresh) refresh.style.display = "none";
    if (timer) timer.innerText = "";
}

// ===============================
// 👤 USUÁRIO
// ===============================
async function loadUser() {
    const res = await fetch(API + "/auth/me", { credentials: "include" });
    if (!res.ok) return location.href = "/login";

    const { user } = await res.json();
    currentUser = user;

    document.getElementById("user-id").innerText = user.id;
    document.getElementById("user-name").innerText = user.name;
    document.getElementById("user-prompt").value = user.prompt;
    updateCharCount(); // Atualizar contador ao carregar

    // Renderizar indicador de uso de IA
    renderIaUsage(user);

    // Carregar configuração de silêncio
    renderSilenceConfig(user);

    // 🔒 garante que QR e loading começam escondidos
    hideQrUI();

    listSessions();
}

// ===============================
// 🤖 INDICADOR DE USO DA IA
// ===============================
function renderIaUsage(user) {
    const LIMITS = { free: 500, starter: 500, pro: null };

    const wrap      = document.getElementById("ia-usage-wrap");
    const countEl   = document.getElementById("ia-usage-count");
    const barEl     = document.getElementById("ia-progress-bar");
    const remaining = document.getElementById("ia-usage-remaining");

    if (!wrap) return;

    const used  = Number(user.ia_messages_used) || 0;
    const plan  = user.plan || "free";
    const limit = LIMITS[plan] ?? null;

    wrap.style.display = "block";

    if (limit === null) {
        // Plano ilimitado
        countEl.textContent   = used + " / ∞";
        barEl.style.width     = "100%";
        barEl.className       = "ia-progress-bar bar-unlimited";
        remaining.textContent = "Plano Pro — mensagens ilimitadas 🚀";
        return;
    }

    const pct  = Math.min(100, Math.round((used / limit) * 100));
    const left = Math.max(0, limit - used);

    countEl.textContent = `${used} / ${limit}`;
    barEl.style.width   = pct + "%";

    barEl.className = "ia-progress-bar " +
        (pct >= 90 ? "bar-danger" : pct >= 70 ? "bar-warning" : "bar-ok");

    remaining.textContent = left > 0
        ? `${left} mensagens restantes este mês`
        : "⚠️ Limite atingido — faça upgrade para continuar";

    if (left === 0) remaining.style.color = "#e54848";
}


// ===============================
// ✍️ CONTADOR DE CARACTERES DO PROMPT
// ===============================
function updateCharCount() {
    const textarea = document.getElementById("user-prompt");
    const countEl  = document.getElementById("prompt-count");
    const hintEl   = document.getElementById("prompt-hint");

    if (!textarea || !countEl) return;

    const len = textarea.value.length;
    countEl.textContent = len + " caracteres";

    // Remover classes anteriores
    countEl.className = "prompt-count";
    hintEl.textContent = "";

    if (len === 0) {
        hintEl.textContent = "Prompt vazio — a IA vai responder sem contexto";
        hintEl.className = "prompt-hint hint-warning";
    } else if (len < 50) {
        hintEl.textContent = "Prompt muito curto — adicione mais contexto para melhores respostas";
        hintEl.className = "prompt-hint hint-warning";
        countEl.className = "prompt-count count-warning";
    } else if (len > 2000) {
        hintEl.textContent = "Prompt muito longo — pode afetar a velocidade da IA";
        hintEl.className = "prompt-hint hint-danger";
        countEl.className = "prompt-count count-danger";
    } else if (len >= 100) {
        hintEl.textContent = "✓ Prompt bem configurado";
        hintEl.className = "prompt-hint hint-ok";
        countEl.className = "prompt-count count-ok";
    }
}

// ===============================
// 🌙 HORÁRIO DE SILÊNCIO
// ===============================
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
async function loadStats() {
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
        set("stat-ia",           data.iaUsado);

    } catch (err) {
        console.warn("Erro ao carregar stats:", err);
        // Mostrar 0 em caso de erro
        ["stat-sessions","stat-clientes","stat-agendamentos","stat-ia"]
            .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = "0"; });
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
// 📝 PROMPT
// ===============================
async function updatePrompt() {
    const prompt = document.getElementById("user-prompt").value;

    await fetch(API + "/user/update-prompt", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
    });

    notify("Prompt atualizado com sucesso", "success");
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

    const box = document.getElementById("sessions-list");
    box.innerHTML = "";

    if (!sessions.length) {
        box.innerHTML = `
            <div class="session-empty">
                <i class="fa-brands fa-whatsapp"></i>
                <p>Nenhuma sessão cadastrada ainda</p>
            </div>`;
        checkConnectionAlert(sessions);
        return;
    }

    sessions.forEach(s => {
        const isConnected    = s.status === "connected";
        const isReconnecting = s.status === "reconnecting";
        const isPending      = s.status === "pending";

        const badgeClass = isConnected    ? "badge-connected"
                         : isReconnecting ? "badge-reconnecting"
                         : isPending      ? "badge-pending"
                         : "badge-disconnected";

        const badgeLabel = isConnected    ? "Conectado"
                         : isReconnecting ? "Reconectando..."
                         : isPending      ? "Aguardando QR"
                         : "Desconectado";

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
                </div>
            </div>
            <div class="session-actions">
                ${!isConnected ? `
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

    checkConnectionAlert(sessions);
}

async function restartSession(name) {
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

    if (!box || !img) return;

    // mostrar container
    box.classList.remove("hidden");
    box.style.display = "block";

    // esconder loading IMEDIATAMENTE
    const loading = document.getElementById("qr-loading");
    if (loading) loading.style.display = "none";

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

    if (box) {
        box.classList.remove("hidden");
        box.style.display = "block";
    }

    if (loading) loading.style.display = "flex";
    if (img) img.style.display = "none";
}

function showQrImage(src) {
    const loading = document.getElementById("qr-loading");
    const img = document.getElementById("qr-img");

    if (!img) return;

    img.onload = () => {
        if (loading) loading.style.display = "none";
        img.style.display = "block";
    };

    img.src = src;
}
function hideQrLoading() {
    const loading = document.getElementById("qr-loading");
    if (loading) loading.style.display = "none";
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
