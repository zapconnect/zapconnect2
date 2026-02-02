// ===============================
// 🌍 API
// ===============================
const API = window.APP_CONFIG?.API_URL || window.location.origin;

// ===============================
// 🎫 VARIÁVEIS
// ===============================
let qrTimer = null;
let currentUser = null;

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
window.onload = loadUser;

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

    // 🔒 garante que QR e loading começam escondidos
    hideQrUI();

    listSessions();
}


// ===============================
// 🚪 LOGOUT (CORRETO)
// ===============================
async function logout() {
    try {
        await fetch(API + "/auth/logout", {
            method: "POST",
            credentials: "include" // 🔥 OBRIGATÓRIO
        });

        // limpeza extra (opcional, mas recomendado)
        localStorage.clear();
        sessionStorage.clear();

        window.location.href = "/login";
    } catch (err) {
        console.error("Erro ao sair:", err);
        alert("Erro ao sair da conta");
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

    alert("Prompt atualizado!");
}

// ===============================
// 📱 CRIAR SESSÃO
// ===============================
async function createSession() {
    const name = document.getElementById("session-name").value.trim();
    if (!name) return alert("Informe o nome!");

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
        return alert(data.error);
    }

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
    const box = document.getElementById("sessions-list");
    box.innerHTML = "";

    sessions.forEach(s => {
        const div = document.createElement("div");
        div.className = "session-row";

        div.innerHTML = `
      <div>
        <b>${s.session_name}</b> ${s.status === "connected" ? "" : ""}
        <br><small>${s.status}</small>
      </div>
      <button onclick="deleteSession('${s.session_name}')">Apagar</button>
    `;

        box.appendChild(div);
    });
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
        alert("Erro ao alterar IA");
        checkbox.checked = !enabled;
        return;
    }

    document.getElementById("ia-status").innerText =
        enabled ? "Ativada" : "Desativada";
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
