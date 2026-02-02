/**********************************************************
 *  CHAT.JS — VISUAL WhatsApp MULTIUSUÁRIO + WPPConnect
 *  Compatível com painel, CRM e Modo IA/Humano
 **********************************************************/

/* ==========================================================
   🔗 SOCKET.IO COM AUTENTICAÇÃO DO USUÁRIO
   ========================================================== */
if (!window.USER_ID || !window.USER_TOKEN) {
    alert("Sessão expirada. Faça login novamente.");
    window.location.href = "/login";
}

const socket = io({
    auth: { userId: window.USER_ID }
});

/* ==========================================================
   📥 VARIÁVEIS GLOBAIS
   ========================================================== */
const chats = {};
let currentChat = null;

/* ==========================================================
   🧱 ELEMENTOS DOM
   ========================================================== */
const chatTitle = document.getElementById("chatTitle");
const humanButtons = document.getElementById("humanButtons");
const tagHuman = document.getElementById("tagHuman");
const searchBox = document.getElementById("searchBox");
const btnHumanOn = document.getElementById("btnHumanOn");
const btnHumanOff = document.getElementById("btnHumanOff");
const humanAlert = document.getElementById("humanAlert");
const pipelineStatus = document.getElementById("pipelineStatus");

const inputMsg = document.getElementById("inputMsg");
const btnSend = document.getElementById("btnSend");

const btnAiToggle = document.getElementById("btnAiToggle");
const tagAiOff = document.getElementById("tagAiOff");

/* ==========================================================
   🏷️ TRATAMENTO DO NOME DO CONTATO
   ========================================================== */
function extrairNome(chat) {
    try {
        if (!chat) return "Contato";
        return (
            chat.displayName ||
            chat.formattedName ||
            chat.pushname ||
            chat.name ||
            (chat.contact ? (
                chat.contact.formattedName ||
                chat.contact.pushname ||
                chat.contact.name
            ) : null) ||
            (chat.id?._serialized || chat.id || "").replace("@c.us", "")
        );
    } catch {
        return "Contato";
    }
}

/* ==========================================================
   🔍 DETECTAR MENSAGEM DO ADMIN (FROM ME)
   ========================================================== */
function resolveIsFromMe(msg) {
    try {
        return msg._isFromMe || msg.fromMe || msg.isFromMe || msg.fromBot;
    } catch {
        return false;
    }
}

/* ==========================================================
   💾 GARANTIR CHAT EM MEMÓRIA
   ========================================================== */
function ensureChat(chatId, name) {
    if (!chatId) return;
    if (!chats[chatId]) {
        chats[chatId] = {
            name: name || chatId.replace("@c.us", ""),
            human: false,
            ai: true,
            msgs: [],
            pic: null,
            pipeline: "Novo"
        };
    }
}

/* ==========================================================
   🎨 RENDERIZAR LISTA DE CHATS
   ========================================================== */
function renderChatList(filter = "") {
    const cont = document.getElementById("chatlist");
    cont.innerHTML = "";

    Object.keys(chats).forEach(id => {
        if (filter && !chats[id].name.toLowerCase().includes(filter.toLowerCase())) return;

        const div = document.createElement("div");
        div.className =
            "chat-item" +
            (id === currentChat ? " active" : "") +
            (chats[id].human ? " chat-human" : "") +
            (chats[id].ai === false ? " chat-ai-off" : "");

        div.dataset.chatId = id;
        div.onclick = () => selectChat(id);

        div.innerHTML = `
            <img class="avatar" src="${chats[id].pic || "/img/no-photo.png"}">
            <div class="chat-infos">
                <div class="chat-name">${chats[id].name}</div>
            </div>
        `;
        cont.appendChild(div);
    });
}

/* ==========================================================
   📌 SELECIONAR CHAT
   ========================================================== */
/* ==========================================================
   📌 SELECIONAR CHAT + RECARREGAR MODO HUMANO + TIMER
   ========================================================== */
async function selectChat(chatId) {
    currentChat = chatId;

    // Solicita mensagens ao servidor
    socket.emit("abrir_chat", chatId);

    // Marca visualmente o chat ativo
    document.querySelectorAll(".chat-item").forEach(n => n.classList.remove("active"));
    const active = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`);
    if (active) active.classList.add("active");

    // Nome no topo
    chatTitle.textContent = chats[chatId].name;

    // Mostrar controles
    humanButtons.style.display = "flex";

    // Botões modo humano
    btnHumanOn.disabled = chats[chatId].human;
    btnHumanOff.disabled = !chats[chatId].human;

    // TAGs
    tagHuman.style.display = chats[chatId].human ? "inline-flex" : "none";
    humanAlert.style.display = chats[chatId].human ? "block" : "none";

    // TIMER DO MODO HUMANO ===========================
    if (chats[chatId].human && chats[chatId].expire) {
        const diff = chats[chatId].expire - Date.now();
        if (diff > 0) {
            startHumanTimer(diff);   // retomar tempo restante
        } else {
            stopHumanTimer();        // expirado → não mostra nada
        }
    } else {
        stopHumanTimer();            // sem modo humano
    }
    // ================================================

    // Atualiza UI da IA
    updateAiUi(chatId);

    // Renderizar mensagens
    renderMessages(chatId);

    // Pipeline/CRM
    try {
        const res = await fetch(`/api/crm/client/${chatId}`);
        const data = await res.json();
        const stage = data.pipeline || "Novo";
        chats[chatId].pipeline = stage;

        pipelineStatus.innerHTML = `
            <span class="pipeline-dot pipeline-${stage.replace(/\s+/g, '')}"></span>
            ${stage}
        `;
    } catch {
        pipelineStatus.innerHTML = "";
    }
}



/* ==========================================================
   💬 RENDERIZAR MENSAGENS + MIDIAS
   ========================================================== */
function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function renderMessages(chatId) {
    const box = document.getElementById("messages");
    box.innerHTML = "";

    chats[chatId].msgs.forEach(msg => {
        msg.timestamp = msg.timestamp || Date.now();
        const fromMe = resolveIsFromMe(msg);

        const row = document.createElement("div");
        row.className = "msg-row " + (fromMe ? "from-user" : "from-bot");

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";

        if (msg.isMedia || msg.mimetype) {
            msg.isMedia = true;
            const mime = msg.mimetype || "";

            if (mime.startsWith("image/")) {
                bubble.innerHTML = `<img class="msg-img" src="data:${mime};base64,${msg.body}">`;
            } else if (mime.startsWith("audio/") || mime.includes("opus")) {
                bubble.innerHTML = `
                    <audio controls class="msg-audio">
                        <source src="data:${mime};base64,${msg.body}" type="${mime}">
                    </audio>`;
            } else if (mime.startsWith("video/")) {
                bubble.innerHTML = `<video controls class="msg-video" src="data:${mime};base64,${msg.body}"></video>`;
            } else {
                bubble.innerHTML = `<a download href="data:${mime};base64,${msg.body}">📎 Arquivo (${mime})</a>`;
            }
        } else {
            bubble.textContent = msg.body;
        }

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = fmtTime(msg.timestamp);
        bubble.appendChild(meta);

        row.appendChild(bubble);
        box.appendChild(row);
    });

    box.scrollTop = box.scrollHeight;
}

/* ==========================================================
   🚦 MODO HUMANO (5 MINUTOS AUTOMÁTICO)
   ========================================================== */
btnHumanOn.addEventListener("click", () => {
    if (!currentChat) return;

    socket.emit("chat_human_state", { chatId: currentChat, state: true });

    chats[currentChat].human = true;
    btnHumanOn.disabled = true;
    btnHumanOff.disabled = false;
    tagHuman.style.display = "inline-flex";
    humanAlert.style.display = "block";

    startHumanTimer(); // ⏱ Inicia contagem aqui
    renderChatList();
});

btnHumanOff.addEventListener("click", () => {
    if (!currentChat) return;

    socket.emit("chat_human_state", { chatId: currentChat, state: false });

    chats[currentChat].human = false;
    btnHumanOn.disabled = false;
    btnHumanOff.disabled = true;
    tagHuman.style.display = "none";
    humanAlert.style.display = "none";
    btnHumanOff.style.cursor = "pointer";

    stopHumanTimer(); // ⛔ garantir parada
    renderChatList();
});



socket.on("human_state_changed", ({ chatId, state }) => {
    if (!chats[chatId]) return;
    chats[chatId].human = state;

    if (currentChat === chatId) {
        btnHumanOn.disabled = state;
        btnHumanOff.disabled = !state;
        tagHuman.style.display = state ? "inline-flex" : "none";
        humanAlert.style.display = state ? "block" : "none";

        if (state) {
            startHumanTimer(); // ⏱ Inicia quando voltar automático
        } else {
            stopHumanTimer(); // ⛔ Para quando volta pro bot
        }
    }

    renderChatList();
});


/* ==========================================================
   💌 ENVIAR MENSAGEM DO ADMIN
   ========================================================== */
btnSend.addEventListener("click", () => {
    const txt = inputMsg.value.trim();
    if (!txt || !currentChat) return;

    socket.emit("admin_send_message", { chatId: currentChat, body: txt });
    inputMsg.value = "";

    setTimeout(() => renderMessages(currentChat), 40);
});

inputMsg.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        btnSend.click();
    }
});

/* ==========================================================
   🤖 IA POR CHAT
   ========================================================== */
function updateAiUi(chatId) {
    const aiOn = chats[chatId].ai !== false;
    btnAiToggle.style.display = "inline-flex";
    btnAiToggle.textContent = aiOn ? "🔵 IA ligada" : "⚫ IA desligada";
    btnAiToggle.style.background = aiOn ? "#0a84ff" : "#777";
    tagAiOff.style.display = aiOn ? "none" : "inline-block";
}

btnAiToggle.addEventListener("click", () => {
    if (!currentChat) return;
    const aiOn = chats[currentChat].ai !== false;
    socket.emit(aiOn ? "chat_ai_off" : "chat_ai_on", currentChat);
    chats[currentChat].ai = !aiOn;
    updateAiUi(currentChat);
    renderChatList();
});


/* ==========================================================
   🛰️ SOCKET EVENTOS
   ========================================================== */
socket.emit("listar_chats");

socket.on("lista_chats", lista => {
    lista.forEach(chat => {
        const id = chat.id?._serialized || chat.id;
        ensureChat(id, extrairNome(chat));
        chats[id].human = chat.human === true;
        chats[id].ai = chat.ai;

        // 🕒 Salva expiração
        chats[id].expire = chat.expire || null;
    });
    renderChatList();
});


socket.on("mensagens_chat", msgs => {
    if (!currentChat) return;
    chats[currentChat].msgs = msgs || [];

    // 🔥 GARANTIR QUE O STATUS DA IA POR CHAT SEJA ATUALIZADO JUNTO
    socket.emit("chat_ai_state_request", currentChat);

    renderMessages(currentChat);
});



socket.on("profilePic", data => {
    if (!data.chatId) return;
    ensureChat(data.chatId);
    chats[data.chatId].pic = data.url;
    renderChatList();
});

socket.on("newMessage", msg => {
    ensureChat(msg.chatId, msg.name);
    msg.isMedia = msg.isMedia || !!msg.mimetype;
    msg.timestamp = msg.timestamp || Date.now();
    msg._isFromMe = resolveIsFromMe(msg) || msg.fromBot === true;
    chats[msg.chatId].msgs.push(msg);
    if (currentChat === msg.chatId) renderMessages(msg.chatId);
    renderChatList();
});

socket.on("chat_ai_state", ({ chatId, state }) => {
    if (!chats[chatId]) return;
    chats[chatId].ai = state;
    if (currentChat === chatId) updateAiUi(chatId);
    renderChatList();
});


/* ==========================================================
   🔎 PESQUISA
   ========================================================== */
searchBox.addEventListener("input", e => renderChatList(e.target.value));

/* ==========================================================
   😀 MODAL DE EMOJIS
   ========================================================== */
const emojiModal = document.getElementById("emojiModal");
const emojiGrid = document.getElementById("emojiGrid");
const btnEmoji = document.querySelector(".btn-emoji");
const closeEmoji = document.getElementById("closeEmoji");

const emojis = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😍", "🤩", "😘", "😗", "😚", "😋", "😜", "🤪", "😝", "🤑", "🤯", "🥶", "🥵", "😎", "🤓", "🤫", "😕", "😟", "🙁", "😢", "😭", "😱", "😖", "😡", "🤬", "👍", "👌", "👏", "🙏", "🔥", "❤️", "💙", "💚", "💛", "💜", "🤍", "🤎", "🖤", "⭐", "💥", "💯", "🚀"];

emojis.forEach(e => {
    const span = document.createElement("span");
    span.textContent = e;
    span.onclick = () => {
        inputMsg.value += e;
        inputMsg.focus();
    };
    emojiGrid.appendChild(span);
});

btnEmoji.addEventListener("click", () => emojiModal.style.display = "flex");
closeEmoji.addEventListener("click", () => emojiModal.style.display = "none");
emojiModal.addEventListener("click", e => {
    if (e.target === emojiModal) emojiModal.style.display = "none";
});
/* ==========================================================
   ⏱️ TIMER DO MODO HUMANO (CONTAGEM REGRESSIVA)
   ========================================================== */
let intervalHumanTimer = null;
let humanTimeoutDate = null;

function startHumanTimer(ms = 5 * 60 * 1000) {
    const span = document.getElementById("humanTimer");
    if (!span) return;

    // Hora que termina
    humanTimeoutDate = Date.now() + ms;

    clearInterval(intervalHumanTimer);

    intervalHumanTimer = setInterval(() => {
        const diff = humanTimeoutDate - Date.now();
        if (diff <= 0) {
            span.textContent = "🤖 Voltando para o bot...";
            clearInterval(intervalHumanTimer);
            return;
        }

        const min = Math.floor(diff / 1000 / 60);
        const sec = Math.floor((diff / 1000) % 60);
        span.textContent = `⏳ ${min}:${sec.toString().padStart(2, "0")} restante(s)`;
    }, 1000);
}

function stopHumanTimer() {
    clearInterval(intervalHumanTimer);
    const span = document.getElementById("humanTimer");
    if (span) span.textContent = "";
}
