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
            pipeline: "Novo",
            lastMsg: null,  // { body, fromMe, timestamp, isMedia, mimetype }
            unread: 0       // contador de mensagens não lidas
        };
    }
}

/* ==========================================================
   🔤 PREVIEW DA ÚLTIMA MENSAGEM
   ========================================================== */
function getLastMsgPreview(chat) {
    const msg = chat.lastMsg;
    if (!msg) return "";

    const prefix = msg.fromMe ? "Você: " : "";

    if (msg.isMedia) {
        const icons = {
            "image": "📷 Foto",
            "audio": "🎵 Áudio",
            "video": "🎥 Vídeo"
        };
        const type = Object.keys(icons).find(k => (msg.mimetype || "").startsWith(k)) || "document";
        return prefix + (icons[type] || "📄 Arquivo");
    }

    const text = (msg.body || "").trim();
    return prefix + (text.length > 38 ? text.slice(0, 38) + "…" : text);
}

function fmtLastTime(ts) {
    if (!ts) return "";
    const now = new Date();
    const d = new Date(ts);

    if (d.toDateString() === now.toDateString()) {
        return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Ontem";

    return d.getDate().toString().padStart(2, "0") + "/" + (d.getMonth() + 1).toString().padStart(2, "0");
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

        const preview = getLastMsgPreview(chats[id]);
        const lastTime = fmtLastTime(chats[id].lastMsg?.timestamp);
        const unread = chats[id].unread || 0;

        div.innerHTML = `
            <img class="avatar" src="${chats[id].pic || "/img/no-photo.png"}">
            <div class="chat-infos">
                <div class="chat-name-row">
                    <div class="chat-name">${chats[id].name}</div>
                    <div class="chat-time">${lastTime}</div>
                </div>
                <div class="chat-preview-row">
                    <div class="chat-preview">${preview}</div>
                    ${unread > 0 ? `<div class="chat-unread">${unread > 99 ? "99+" : unread}</div>` : ""}
                </div>
            </div>
        `;
        cont.appendChild(div);
    });
}

/* ==========================================================
   📌 SELECIONAR CHAT + RECARREGAR MODO HUMANO + TIMER
   ========================================================== */
async function selectChat(chatId) {
    currentChat = chatId;

    // Solicita mensagens ao servidor
    socket.emit("abrir_chat", chatId);

    // Zerar contador de não lidas ao abrir o chat
    if (chats[chatId]) {
        chats[chatId].unread = 0;
        renderChatList();
    }

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
            startHumanTimer(diff);
        } else {
            stopHumanTimer();
        }
    } else {
        stopHumanTimer();
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

    socket.emit("chat_human_state", {
        chatId: currentChat,
        state: true,
        sessionName: window.SESSION_NAME
    });

    chats[currentChat].human = true;
    btnHumanOn.disabled = true;
    btnHumanOff.disabled = false;
    tagHuman.style.display = "inline-flex";
    humanAlert.style.display = "block";

    startHumanTimer();
    renderChatList();
});

btnHumanOff.addEventListener("click", () => {
    if (!currentChat) return;

    socket.emit("chat_human_state", {
        chatId: currentChat,
        state: false,
        sessionName: window.SESSION_NAME
    });

    chats[currentChat].human = false;
    btnHumanOn.disabled = false;
    btnHumanOff.disabled = true;
    tagHuman.style.display = "none";
    humanAlert.style.display = "none";
    btnHumanOff.style.cursor = "pointer";

    stopHumanTimer();
    renderChatList();
});

socket.on("human_state_changed", ({ chatId, state, expireAt }) => {
    if (!chats[chatId]) return;

    chats[chatId].human = state;
    chats[chatId].expire = expireAt || null;

    if (currentChat === chatId) {
        btnHumanOn.disabled = state;
        btnHumanOff.disabled = !state;
        tagHuman.style.display = state ? "inline-flex" : "none";
        humanAlert.style.display = state ? "block" : "none";

        if (state && expireAt) {
            const diff = expireAt - Date.now();
            if (diff > 0) startHumanTimer(diff);
            else stopHumanTimer();
        } else {
            stopHumanTimer();
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
        chats[id].expire = chat.expire || null;
    });
    renderChatList();
});

socket.on("mensagens_chat", msgs => {
    if (!currentChat) return;
    chats[currentChat].msgs = msgs || [];

    // Atualizar preview com a última mensagem do histórico
    if (msgs && msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        chats[currentChat].lastMsg = {
            body: last.body,
            fromMe: resolveIsFromMe(last),
            timestamp: last.timestamp,
            isMedia: last.isMedia || !!last.mimetype,
            mimetype: last.mimetype || ""
        };
        renderChatList();
    }

    // Garantir que o status da IA por chat seja atualizado junto
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

    // Atualizar preview da última mensagem
    chats[msg.chatId].lastMsg = {
        body: msg.body,
        fromMe: msg._isFromMe,
        timestamp: msg.timestamp,
        isMedia: msg.isMedia,
        mimetype: msg.mimetype || ""
    };

    // Incrementar não lidas só se o chat não estiver aberto
    if (currentChat !== msg.chatId) {
        chats[msg.chatId].unread = (chats[msg.chatId].unread || 0) + 1;
    }

    if (currentChat === msg.chatId) {
        hideTyping(); // remove indicador ao receber resposta real
        renderMessages(msg.chatId);
    }
    renderChatList();
});

socket.on("chat_ai_state", ({ chatId, state }) => {
    if (!chats[chatId]) return;
    chats[chatId].ai = state;
    if (currentChat === chatId) updateAiUi(chatId);
    renderChatList();
});


/* ==========================================================
   ✍️ INDICADOR "DIGITANDO..."
   ========================================================== */
let typingTimerCleanup = null;

function showTyping(chatId) {
    if (currentChat !== chatId) return;

    // Remove indicador anterior se existir
    hideTyping();

    const box = document.getElementById("messages");
    const row = document.createElement("div");
    row.className = "msg-row from-bot";
    row.id = "typing-indicator";

    row.innerHTML = `
        <div class="msg-bubble typing-bubble">
            <div class="typing-dots">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;

    box.appendChild(row);
    box.scrollTop = box.scrollHeight;

    // Segurança: remove automaticamente após 15s caso o stop não chegue
    typingTimerCleanup = setTimeout(() => hideTyping(), 15000);
}

function hideTyping() {
    if (typingTimerCleanup) {
        clearTimeout(typingTimerCleanup);
        typingTimerCleanup = null;
    }
    const el = document.getElementById("typing-indicator");
    if (el) el.remove();
}

socket.on("typing:start", ({ chatId }) => {
    showTyping(chatId);
});

socket.on("typing:stop", ({ chatId }) => {
    if (currentChat === chatId) hideTyping();
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