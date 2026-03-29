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
let selectedFile = null;
let searchQuery = "";    // termo de busca atual
let pendingHumanDurationMs = null; // duração selecionada ao clicar Atender
let searchMatches = [];  // índices das mensagens com match
let searchCurrent = 0;   // match focado atualmente // { base64, filename, mimetype }

/* ==========================================================
   🧱 ELEMENTOS DOM
   ========================================================== */
const chatTitle = document.getElementById("chatTitle");
const humanButtons = document.getElementById("humanButtons");
const tagHuman = document.getElementById("tagHuman");
const searchBox = document.getElementById("searchBox");
const btnHumanOn       = document.getElementById("btnHumanOn");
const humanDuration    = document.getElementById("humanDuration");
const btnHumanOff = document.getElementById("btnHumanOff");
const humanAlert = document.getElementById("humanAlert");
const pipelineStatus = document.getElementById("pipelineStatus");

const inputMsg = document.getElementById("inputMsg");
const btnSend = document.getElementById("btnSend");

const btnAiToggle  = document.getElementById("btnAiToggle");
const btnClearAi   = document.getElementById("btnClearAi");
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

    // Parar piscar título ao abrir o chat
    stopTitleBlink();

    // Resetar busca ao trocar de chat
    searchQuery = "";
    searchMatches = [];
    searchCurrent = 0;
    if (searchInput) searchInput.value = "";
    if (searchBar) searchBar.style.display = "none";

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
    if (chats[chatId].human) {
        if (chats[chatId].expire === null) {
            // Sem limite
            startHumanTimer(null);
        } else if (chats[chatId].expire) {
            const diff = chats[chatId].expire - Date.now();
            if (diff > 0) startHumanTimer(diff);
            else stopHumanTimer();
        } else if (chats[chatId].humanDurationMs !== undefined) {
            startHumanTimer(chats[chatId].humanDurationMs);
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

/* ==========================================================
   🔦 HIGHLIGHT DE TEXTO NA BUSCA
   ========================================================== */
function highlightText(text, query) {
    if (!query) return document.createTextNode(text);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${escaped})`, "gi");
    const parts = text.split(regex);
    const span = document.createDocumentFragment();
    parts.forEach(part => {
        if (regex.test(part)) {
            const mark = document.createElement("mark");
            mark.className = "search-highlight";
            mark.textContent = part;
            span.appendChild(mark);
        } else {
            span.appendChild(document.createTextNode(part));
        }
    });
    return span;
}

function renderMessages(chatId) {
    const box = document.getElementById("messages");
    box.innerHTML = "";
    searchMatches = [];

    chats[chatId].msgs.forEach((msg, idx) => {
        msg.timestamp = msg.timestamp || Date.now();
        const fromMe = resolveIsFromMe(msg);

        const row = document.createElement("div");
        row.className = "msg-row " + (fromMe ? "from-user" : "from-bot");
        row.dataset.msgIdx = idx;

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
            // Texto — aplica highlight se houver busca
            const body = msg.body || "";
            if (searchQuery && body.toLowerCase().includes(searchQuery.toLowerCase())) {
                bubble.appendChild(highlightText(body, searchQuery));
                row.classList.add("msg-match");
                searchMatches.push(idx);
            } else {
                bubble.textContent = body;
            }
        }

        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = fmtTime(msg.timestamp);
        bubble.appendChild(meta);

        row.appendChild(bubble);
        box.appendChild(row);
    });

    // Atualizar contador de resultados
    updateSearchCounter();

    // Sem busca ativa: rolar para o fim normalmente
    if (!searchQuery) {
        box.scrollTop = box.scrollHeight;
    } else if (searchMatches.length > 0) {
        scrollToMatch(searchCurrent);
    }
}

/* ==========================================================
   🚦 MODO HUMANO (5 MINUTOS AUTOMÁTICO)
   ========================================================== */
btnHumanOn.addEventListener("click", () => {
    if (!currentChat) return;

    // Ler duração selecionada — "null" vira null, outros viram número
    const rawDuration = humanDuration?.value;
    const durationMs  = rawDuration === "null" ? null : Number(rawDuration);

    // Guardar localmente para usar no human_state_changed
    pendingHumanDurationMs = durationMs;

    socket.emit("chat_human_state", {
        chatId: currentChat,
        state: true,
        sessionName: window.SESSION_NAME,
        durationMs
    });

    // Guardar duração localmente para o timer não ser sobrescrito
    chats[currentChat].humanDurationMs = durationMs;
    chats[currentChat].human = true;
    btnHumanOn.disabled = true;
    btnHumanOff.disabled = false;
    tagHuman.style.display = "inline-flex";
    humanAlert.style.display = "block";

    // Iniciar timer com a duração selecionada
    startHumanTimer(chats[currentChat].humanDurationMs ?? 5 * 60 * 1000);
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
    // Guardar expireAt (null é válido = sem limite)
    chats[chatId].expire = (expireAt !== undefined) ? expireAt : null;

    if (currentChat === chatId) {
        btnHumanOn.disabled = state;
        btnHumanOff.disabled = !state;
        tagHuman.style.display = state ? "inline-flex" : "none";
        humanAlert.style.display = state ? "block" : "none";

        if (state) {
            // ✅ Prioridade 1: duração que o operador selecionou ao clicar Atender
            //    (evita que o server sobrescreva com 5 min padrão)
            if (pendingHumanDurationMs !== undefined) {
                startHumanTimer(pendingHumanDurationMs);
                pendingHumanDurationMs = undefined; // consumir flag
            }
            // ✅ Prioridade 2: expireAt explicitamente null = sem limite
            else if (expireAt === null) {
                startHumanTimer(null);
            }
            // ✅ Prioridade 3: expireAt numérico do servidor
            else if (expireAt) {
                const diff = expireAt - Date.now();
                if (diff > 0) startHumanTimer(diff);
                else stopHumanTimer();
            }
            else {
                stopHumanTimer();
            }
        } else {
            pendingHumanDurationMs = undefined;
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
    if (!currentChat) return;
    if (!txt && !selectedFile) return;

    if (selectedFile) {
        // Enviar arquivo (com legenda opcional)
        socket.emit("admin_send_message", {
            chatId:   currentChat,
            body:     txt,
            file:     selectedFile.base64,
            filename: selectedFile.filename,
            mimetype: selectedFile.mimetype
        });
        clearFile();
    } else {
        // Enviar só texto
        socket.emit("admin_send_message", { chatId: currentChat, body: txt });
    }

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
    // Mostra botão de reset só quando a IA está ativa
    btnClearAi.style.display = aiOn ? "inline-flex" : "none";
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

// Abrir chat direto se vier ?contact= na URL (ex: vindo do CRM)
const contactParam = new URLSearchParams(window.location.search).get("contact");

socket.on("lista_chats", lista => {
    lista.forEach(chat => {
        const id = chat.id?._serialized || chat.id;
        ensureChat(id, extrairNome(chat));
        chats[id].human = chat.human === true;
        chats[id].ai = chat.ai;
        chats[id].expire = chat.expire || null;
    });
    renderChatList();

    // Abrir chat do contato vindo do CRM automaticamente
    if (contactParam) {
        const chatId = `${contactParam}@c.us`;
        ensureChat(chatId, contactParam);
        selectChat(chatId);

        // Limpar parâmetro da URL sem recarregar a página
        const url = new URL(window.location.href);
        url.searchParams.delete("contact");
        window.history.replaceState({}, "", url);
    }
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

    // Incrementar não lidas + notificar se chat não está aberto
    if (currentChat !== msg.chatId && !msg._isFromMe) {
        chats[msg.chatId].unread = (chats[msg.chatId].unread || 0) + 1;

        // 🔊 Som de notificação
        createNotificationSound();

        // 💬 Piscar título da aba
        const senderName = chats[msg.chatId].name || "Nova mensagem";
        if (document.hidden || document.visibilityState === "hidden") {
            startTitleBlink(senderName);
        }
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
   📎 ENVIO DE ARQUIVOS
   ========================================================== */
const btnAttach   = document.getElementById("btnAttach");
const fileInput   = document.getElementById("fileInput");
const filePreview = document.getElementById("filePreview");
const filePreviewImg  = document.getElementById("filePreviewImg");
const filePreviewDoc  = document.getElementById("filePreviewDoc");
const filePreviewName = document.getElementById("filePreviewName");
const fileClear   = document.getElementById("fileClear");

btnAttach.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;

    const maxMB = 15;
    if (file.size > maxMB * 1024 * 1024) {
        alert(`Arquivo muito grande. Máximo: ${maxMB}MB`);
        fileInput.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const dataUrl = e.target.result;

        if (file.type.startsWith("image/")) {
            // 🔄 Comprimir imagem antes de enviar (resolve PNG grande)
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const MAX_DIM = 1280;
                let w = img.width, h = img.height;

                if (w > MAX_DIM || h > MAX_DIM) {
                    if (w > h) { h = Math.round(h * MAX_DIM / w); w = MAX_DIM; }
                    else       { w = Math.round(w * MAX_DIM / h); h = MAX_DIM; }
                }

                canvas.width = w;
                canvas.height = h;
                canvas.getContext("2d").drawImage(img, 0, 0, w, h);

                // Sempre salva como JPEG para reduzir tamanho
                const compressed = canvas.toDataURL("image/jpeg", 0.85);
                const base64 = compressed.split(",")[1];
                const filename = file.name.replace(/\.[^.]+$/, ".jpg");

                selectedFile = { base64, filename, mimetype: "image/jpeg" };

                filePreviewImg.src = compressed;
                filePreviewImg.style.display = "block";
                filePreviewDoc.style.display = "none";
                filePreview.style.display = "block";
            };
            img.src = dataUrl;
        } else {
            // Arquivo não-imagem: envia direto
            const base64 = dataUrl.split(",")[1];
            selectedFile = { base64, filename: file.name, mimetype: file.type };

            filePreviewImg.style.display = "none";
            filePreviewDoc.style.display = "flex";
            filePreviewName.textContent = file.name;
            filePreview.style.display = "block";
        }
    };
    reader.readAsDataURL(file);
    fileInput.value = "";
});

fileClear.addEventListener("click", clearFile);

function clearFile() {
    selectedFile = null;
    filePreview.style.display = "none";
    filePreviewImg.src = "";
    filePreviewImg.style.display = "none";
    filePreviewDoc.style.display = "none";
    filePreviewName.textContent = "";
}


/* ==========================================================
   🔍 BUSCA DENTRO DA CONVERSA
   ========================================================== */
const btnSearch    = document.getElementById("btnSearch");
const searchBar    = document.getElementById("searchBar");
const searchInput  = document.getElementById("searchInput");
const searchClose  = document.getElementById("searchClose");
const searchPrev   = document.getElementById("searchPrev");
const searchNext   = document.getElementById("searchNext");
const searchCount  = document.getElementById("searchCount");

function updateSearchCounter() {
    if (!searchQuery || searchMatches.length === 0) {
        searchCount.textContent = searchQuery ? "0 resultados" : "";
        return;
    }
    searchCount.textContent = `${searchCurrent + 1} de ${searchMatches.length}`;
}

function scrollToMatch(idx) {
    if (searchMatches.length === 0) return;

    // Remove foco anterior
    document.querySelectorAll(".msg-row.search-focus").forEach(el => el.classList.remove("search-focus"));

    const targetIdx = searchMatches[idx];
    const row = document.querySelector(`.msg-row[data-msg-idx="${targetIdx}"]`);
    if (row) {
        row.classList.add("search-focus");
        row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    updateSearchCounter();
}

function runSearch(query) {
    searchQuery = query.trim();
    searchMatches = [];
    searchCurrent = 0;
    if (currentChat) renderMessages(currentChat);
}

btnSearch.addEventListener("click", () => {
    const visible = searchBar.style.display !== "none";
    searchBar.style.display = visible ? "none" : "flex";
    if (!visible) {
        searchInput.focus();
    } else {
        searchInput.value = "";
        runSearch("");
    }
});

searchClose.addEventListener("click", () => {
    searchBar.style.display = "none";
    searchInput.value = "";
    runSearch("");
});

searchInput.addEventListener("input", (e) => {
    runSearch(e.target.value);
});

searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        if (searchMatches.length === 0) return;
        searchCurrent = e.shiftKey
            ? (searchCurrent - 1 + searchMatches.length) % searchMatches.length
            : (searchCurrent + 1) % searchMatches.length;
        scrollToMatch(searchCurrent);
    }
    if (e.key === "Escape") searchClose.click();
});

searchNext.addEventListener("click", () => {
    if (searchMatches.length === 0) return;
    searchCurrent = (searchCurrent + 1) % searchMatches.length;
    scrollToMatch(searchCurrent);
});

searchPrev.addEventListener("click", () => {
    if (searchMatches.length === 0) return;
    searchCurrent = (searchCurrent - 1 + searchMatches.length) % searchMatches.length;
    scrollToMatch(searchCurrent);
});


/* ==========================================================
   🔔 NOTIFICAÇÕES SONORAS E VISUAIS
   ========================================================== */
const originalTitle = document.title;
let titleBlinkInterval = null;
let notifAudio = null;

// Criar som de notificação via Web Audio API (sem arquivo externo)
function createNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Tom 1 — beep suave
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.frequency.value = 880;
        osc1.type = "sine";
        gain1.gain.setValueAtTime(0, ctx.currentTime);
        gain1.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.01);
        gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.15);

        // Tom 2 — nota mais alta logo depois
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1100;
        osc2.type = "sine";
        gain2.gain.setValueAtTime(0, ctx.currentTime + 0.1);
        gain2.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
        osc2.start(ctx.currentTime + 0.1);
        osc2.stop(ctx.currentTime + 0.3);
    } catch { }
}

function startTitleBlink(name) {
    if (titleBlinkInterval) return; // já piscando
    let show = true;
    titleBlinkInterval = setInterval(() => {
        document.title = show ? `💬 ${name}` : originalTitle;
        show = !show;
    }, 1000);
}

function stopTitleBlink() {
    if (titleBlinkInterval) {
        clearInterval(titleBlinkInterval);
        titleBlinkInterval = null;
    }
    document.title = originalTitle;
}

// Parar piscar quando a aba volcar ao foco
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) stopTitleBlink();
});

window.addEventListener("focus", () => stopTitleBlink());


/* ==========================================================
   🧹 LIMPAR HISTÓRICO DA IA (GEMINI)
   ========================================================== */
btnClearAi.addEventListener("click", () => {
    if (!currentChat) return;

    const confirmed = confirm("Resetar o contexto da IA para este chat?\n\nA IA esquecerá tudo que foi dito e começará do zero.");
    if (!confirmed) return;

    socket.emit("ai:clear_history", { chatId: currentChat });

    // Feedback visual imediato
    btnClearAi.textContent = "⏳ Resetando...";
    btnClearAi.disabled = true;
});

socket.on("ai:history_cleared", ({ chatId }) => {
    if (currentChat === chatId) {
        btnClearAi.textContent = "✅ Resetado!";
        setTimeout(() => {
            btnClearAi.textContent = "🧹 Resetar IA";
            btnClearAi.disabled = false;
        }, 2000);
    }
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

    clearInterval(intervalHumanTimer);

    // Sem limite de tempo — só mostrar que está ativo, sem contagem
    if (ms === null) {
        humanTimeoutDate = null;
        span.textContent = "⏱ Sem limite de tempo";
        return;
    }

    humanTimeoutDate = Date.now() + ms;

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