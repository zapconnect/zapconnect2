/**********************************************************
 *  CHAT.JS — VISUAL WhatsApp MULTIUSUÁRIO + WPPConnect
 *  Compatível com painel, CRM e Modo IA/Humano
 **********************************************************/

/* ==========================================================
   🔗 SOCKET.IO COM AUTENTICAÇÃO DO USUÁRIO
   ========================================================== */
if (!window.USER_ID) {
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
const chatNotes = {};
let currentChat = null;
let selectedFile = null;
let searchQuery = "";    // termo de busca atual
let pendingHumanDurationMs = null; // duração selecionada ao clicar Atender
let searchMatches = [];  // índices das mensagens com match
let searchCurrent = 0;   // match focado atualmente // { base64, filename, mimetype }
const pendingChatLoads = new Set();
const chatBootstrap = window.CHAT_BOOTSTRAP || {};
let chatUserUsage = normalizeUserUsage(chatBootstrap.user || {});
let lastUsageRefreshAt = 0;
let quickReplies = [];
let quickReplyMatches = [];
let quickReplyActiveIndex = 0;
let quickReplyLoadingPromise = null;
const DRAFT_STORAGE_KEY = `zapconnect:chat-drafts:${window.USER_ID || "anon"}`;
let draftStore = loadDraftStore();
const CONTACT_TAG_PRESETS = [
    { label: "Quente", tone: "hot" },
    { label: "Morno", tone: "warm" },
    { label: "Frio", tone: "cold" },
    { label: "VIP", tone: "vip" },
    { label: "Suporte", tone: "support" },
];
window.CONTACT_TAGS = window.CONTACT_TAGS || {};
let activeContactTagFilter = "";
let contactTagLoadingPromise = null;
let onboardingCompletionPromise = null;
let onboardingAlreadyCompleted = Number(chatBootstrap?.user?.onboarding_step || 0) >= 4;

async function markChatOnboardingComplete() {
    if (onboardingAlreadyCompleted || onboardingCompletionPromise) return onboardingCompletionPromise;

    onboardingCompletionPromise = fetch("/api/user/onboarding-step", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 4 })
    })
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            onboardingAlreadyCompleted = true;
            if (chatBootstrap?.user) {
                chatBootstrap.user.onboarding_step = 4;
            }
        })
        .catch(err => {
            console.warn("Falha ao sincronizar onboarding do chat:", err);
        })
        .finally(() => {
            onboardingCompletionPromise = null;
        });

    return onboardingCompletionPromise;
}

/* ==========================================================
   🧱 ELEMENTOS DOM
   ========================================================== */
const chatTitle = document.getElementById("chatTitle");
const humanButtons = document.getElementById("humanButtons");
const tagHuman = document.getElementById("tagHuman");
const searchBox = document.getElementById("searchBox");
const chatTagFilters = document.getElementById("chatTagFilters");
const btnHumanOn       = document.getElementById("btnHumanOn");
const humanDuration    = document.getElementById("humanDuration");
const btnHumanOff = document.getElementById("btnHumanOff");
const humanAlert = document.getElementById("humanAlert");
const chatContextBar = document.getElementById("chatContextBar");
const contextCrmPill = document.getElementById("contextCrmPill");
const contextStagePill = document.getElementById("contextStagePill");
const contextAiPill = document.getElementById("contextAiPill");
const contextHintMeta = document.getElementById("contextHintMeta");
const contextUsageMeta = document.getElementById("contextUsageMeta");
const btnContactTags = document.getElementById("btnContactTags");
const contactTagDropdown = document.getElementById("contactTagDropdown");
const contactTagDropdownTitle = document.getElementById("contactTagDropdownTitle");
const contactTagDropdownList = document.getElementById("contactTagDropdownList");
const contactTagDropdownHint = document.getElementById("contactTagDropdownHint");

const inputMsg = document.getElementById("inputMsg");
const btnSend = document.getElementById("btnSend");
const draftBanner = document.getElementById("draftBanner");
const draftBannerText = document.getElementById("draftBannerText");
const btnDraftDiscard = document.getElementById("draftDiscard");
const quickReplyDropdown = document.getElementById("quickReplyDropdown");
const quickReplyDropdownTitle = document.getElementById("quickReplyDropdownTitle");
const quickReplyList = document.getElementById("quickReplyList");
const quickReplyEmpty = document.getElementById("quickReplyEmpty");
const btnQuickReplyManage = document.getElementById("btnQuickReplyManage");
const btnQuickReplyCreateEmpty = document.getElementById("btnQuickReplyCreateEmpty");
const quickReplyModal = document.getElementById("quickReplyModal");
const btnQuickReplyClose = document.getElementById("btnQuickReplyClose");
const quickReplyForm = document.getElementById("quickReplyForm");
const quickReplyShortcut = document.getElementById("quickReplyShortcut");
const quickReplyTitle = document.getElementById("quickReplyTitle");
const quickReplyContent = document.getElementById("quickReplyContent");
const btnQuickReplySave = document.getElementById("btnQuickReplySave");
const quickReplyManagerList = document.getElementById("quickReplyManagerList");
const quickReplyCount = document.getElementById("quickReplyCount");

const btnAiToggle  = document.getElementById("btnAiToggle");
const btnClearAi   = document.getElementById("btnClearAi");
const tagAiOff = document.getElementById("tagAiOff");

const btnNotesToggle = document.getElementById("btnNotesToggle");
const notesPanel   = document.getElementById("notesPanel");
const notesList    = document.getElementById("notesList");
const notesCount   = document.getElementById("notesCount");
const notesRefresh = document.getElementById("notesRefresh");
const noteForm     = document.getElementById("noteForm");
const noteInput    = document.getElementById("noteInput");
const noteSubmit   = document.getElementById("noteSubmit");
let notesVisible = false;

// Sidebar mobile
const btnToggleSidebar = document.getElementById("btnToggleSidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const wrap = document.querySelector(".wrap");

function openSidebar() {
  wrap?.classList.add("sidebar-open");
  if (sidebarOverlay) sidebarOverlay.style.display = "block";
}
function closeSidebar() {
  wrap?.classList.remove("sidebar-open");
  if (sidebarOverlay) sidebarOverlay.style.display = "none";
}
btnToggleSidebar?.addEventListener("click", () => {
  if (wrap?.classList.contains("sidebar-open")) closeSidebar();
  else openSidebar();
});
sidebarOverlay?.addEventListener("click", closeSidebar);

/* ==========================================================
   🧾 AUTO-RESIZE DO CAMPO DE MENSAGEM
   ========================================================== */
const INPUT_MAX_LINES = 5;
const INPUT_LINE_HEIGHT = 22;
function resizeInput() {
  if (!inputMsg) return;
  inputMsg.style.height = "auto";
  const maxHeight = INPUT_MAX_LINES * INPUT_LINE_HEIGHT;
  const newHeight = Math.min(inputMsg.scrollHeight, maxHeight);
  inputMsg.style.height = `${newHeight}px`;
  inputMsg.style.overflowY = inputMsg.scrollHeight > maxHeight ? "auto" : "hidden";
}
inputMsg?.addEventListener("input", resizeInput);
inputMsg?.addEventListener("input", handleQuickReplyInput);
inputMsg?.addEventListener("input", persistCurrentDraftInput);
// reset ao carregar
resizeInput();

function loadDraftStore() {
  try {
    const raw = window.localStorage?.getItem(DRAFT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persistDraftStore() {
  try {
    const entries = Object.entries(draftStore || {}).filter(([, value]) => String(value || "").trim());
    if (!entries.length) {
      window.localStorage?.removeItem(DRAFT_STORAGE_KEY);
      return;
    }

    window.localStorage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Mantém o chat funcional mesmo se o navegador bloquear storage
  }
}

function normalizeDraftText(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function getDraftPreviewText(value, maxLength = 72) {
  const compact = normalizeDraftText(value).replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function getDraftForChat(chatId) {
  if (!chatId) return "";
  return normalizeDraftText(draftStore?.[chatId] || "");
}

function setDraftForChat(chatId, value) {
  if (!chatId) return false;

  const normalized = normalizeDraftText(value);
  const previous = getDraftForChat(chatId);
  if (!normalized.trim()) {
    if (!previous && !Object.prototype.hasOwnProperty.call(draftStore, chatId)) {
      return false;
    }
    delete draftStore[chatId];
    persistDraftStore();
    return true;
  }

  if (previous === normalized) return false;
  draftStore[chatId] = normalized;
  persistDraftStore();
  return true;
}

function refreshChatListView() {
  renderChatList(searchBox?.value || "");
}

function saveComposerDraft(chatId) {
  if (!chatId || !inputMsg) return false;
  return setDraftForChat(chatId, inputMsg.value);
}

function showDraftBanner(chatId) {
  if (!draftBanner || !draftBannerText) return;
  const chatName = chats?.[chatId]?.name || "este contato";
  draftBannerText.textContent = `Retomamos seu rascunho com ${chatName}. Revise antes de enviar.`;
  draftBanner.hidden = false;
  draftBanner.classList.add("is-visible");
}

function hideDraftBanner() {
  if (!draftBanner) return;
  draftBanner.classList.remove("is-visible");
  draftBanner.hidden = true;
}

function restoreDraftForChat(chatId) {
  if (!inputMsg) return false;

  const draft = getDraftForChat(chatId);
  inputMsg.value = draft;
  resizeInput();
  handleQuickReplyInput();

  if (!draft.trim()) {
    hideDraftBanner();
    return false;
  }

  showDraftBanner(chatId);
  return true;
}

function discardCurrentDraft() {
  if (!currentChat || !inputMsg) return;
  setDraftForChat(currentChat, "");
  inputMsg.value = "";
  hideQuickReplyDropdown();
  hideDraftBanner();
  resizeInput();
  refreshChatListView();
  inputMsg.focus();
}

function persistCurrentDraftInput() {
  if (!currentChat || !inputMsg) return;
  setDraftForChat(currentChat, inputMsg.value);
  if (!String(inputMsg.value || "").trim()) {
    hideDraftBanner();
    return;
  }

  if (draftBanner && !draftBanner.hidden) {
    hideDraftBanner();
  }
}

function normalizeQuickReplyShortcut(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function extractQuickReplyQuery(value) {
  const raw = String(value || "");
  if (!raw.startsWith("/")) return null;
  return normalizeQuickReplyShortcut(raw.slice(1).split(/\s+/)[0] || "");
}

function isQuickReplyDropdownOpen() {
  return Boolean(quickReplyDropdown && !quickReplyDropdown.hidden);
}

function hideQuickReplyDropdown() {
  quickReplyMatches = [];
  quickReplyActiveIndex = 0;
  if (quickReplyDropdown) quickReplyDropdown.hidden = true;
}

function showQuickReplyDropdown() {
  if (quickReplyDropdown) quickReplyDropdown.hidden = false;
}

function buildQuickReplyPreview(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

function getQuickReplyFilteredList(query) {
  const normalized = normalizeQuickReplyShortcut(query);
  const list = Array.isArray(quickReplies) ? [...quickReplies] : [];

  return list
    .filter(reply => {
      if (!normalized) return true;
      const shortcut = normalizeQuickReplyShortcut(reply.shortcut);
      const title = String(reply.title || "").toLowerCase();
      return shortcut.includes(normalized) || title.includes(normalized);
    })
    .sort((a, b) => {
      const aShortcut = normalizeQuickReplyShortcut(a.shortcut);
      const bShortcut = normalizeQuickReplyShortcut(b.shortcut);
      const aStarts = normalized ? aShortcut.startsWith(normalized) : false;
      const bStarts = normalized ? bShortcut.startsWith(normalized) : false;
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return aShortcut.localeCompare(bShortcut, "pt-BR");
    });
}

function renderQuickReplyDropdown(query = "") {
  if (!quickReplyDropdown || !quickReplyList || !quickReplyEmpty || !quickReplyDropdownTitle) {
    return;
  }

  const normalized = normalizeQuickReplyShortcut(query);
  quickReplyMatches = getQuickReplyFilteredList(normalized);
  if (quickReplyMatches.length === 0) {
    quickReplyActiveIndex = 0;
  } else if (quickReplyActiveIndex >= quickReplyMatches.length) {
    quickReplyActiveIndex = 0;
  }

  quickReplyDropdownTitle.textContent = normalized
    ? `Atalhos para "/${normalized}"`
    : 'Digite "/" e comece a filtrar seus atalhos';

  quickReplyList.innerHTML = "";

  if (!quickReplies.length && quickReplyLoadingPromise) {
    quickReplyEmpty.hidden = false;
    quickReplyEmpty.querySelector("strong").textContent = "Carregando atalhos salvos";
    quickReplyEmpty.querySelector("p").textContent =
      "Estamos buscando suas respostas rápidas para filtrar em tempo real.";
    showQuickReplyDropdown();
    return;
  }

  if (!quickReplies.length && !quickReplyLoadingPromise) {
    quickReplyEmpty.hidden = false;
    quickReplyEmpty.querySelector("strong").textContent = "Você ainda não salvou respostas rápidas";
    quickReplyEmpty.querySelector("p").textContent =
      "Crie atalhos como /preco, /checkout ou /prazo para reutilizar respostas em um clique.";
    showQuickReplyDropdown();
    return;
  }

  if (!quickReplyMatches.length) {
    quickReplyEmpty.hidden = false;
    quickReplyEmpty.querySelector("strong").textContent = "Nenhum atalho encontrado";
    quickReplyEmpty.querySelector("p").textContent =
      normalized
        ? `Não encontrei atalhos para "/${normalized}". Você pode criar um novo agora.`
        : "Digite após a barra para filtrar seus atalhos salvos.";
    showQuickReplyDropdown();
    return;
  }

  quickReplyEmpty.hidden = true;

  quickReplyMatches.forEach((reply, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `quick-reply-item${index === quickReplyActiveIndex ? " is-active" : ""}`;
    item.dataset.replyId = String(reply.id);
    item.innerHTML = `
      <div class="quick-reply-item-top">
        <span class="quick-reply-shortcut">/${escapeHtml(reply.shortcut)}</span>
        <strong class="quick-reply-title">${escapeHtml(reply.title)}</strong>
      </div>
      <div class="quick-reply-preview">${escapeHtml(buildQuickReplyPreview(reply.content))}</div>
    `;
    item.addEventListener("mouseenter", () => {
      quickReplyActiveIndex = index;
      renderQuickReplyDropdown(normalized);
    });
    item.addEventListener("click", () => {
      applyQuickReply(reply);
    });
    quickReplyList.appendChild(item);
  });

  showQuickReplyDropdown();
}

function handleQuickReplyInput() {
  if (!inputMsg) return;

  const raw = String(inputMsg.value || "");
  if (!raw.startsWith("/")) {
    hideQuickReplyDropdown();
    return;
  }

  const query = extractQuickReplyQuery(raw);
  if (query === null) {
    hideQuickReplyDropdown();
    return;
  }

  if (!quickReplies.length && !quickReplyLoadingPromise) {
    loadQuickReplies();
  }

  renderQuickReplyDropdown(query);
}

function moveQuickReplySelection(direction) {
  if (!quickReplyMatches.length) return;
  quickReplyActiveIndex =
    (quickReplyActiveIndex + direction + quickReplyMatches.length) % quickReplyMatches.length;
  renderQuickReplyDropdown(extractQuickReplyQuery(inputMsg?.value || "") || "");
}

function applyQuickReply(reply) {
  if (!reply || !inputMsg) return;
  inputMsg.value = String(reply.content || "");
  hideQuickReplyDropdown();
  persistCurrentDraftInput();
  hideDraftBanner();
  resizeInput();
  inputMsg.focus();
  inputMsg.setSelectionRange(inputMsg.value.length, inputMsg.value.length);
}

function openQuickReplyModal(prefillShortcut = "") {
  hideQuickReplyDropdown();
  if (!quickReplyModal) return;
  quickReplyModal.hidden = false;
  quickReplyModal.classList.add("open");

  const normalizedPrefill = normalizeQuickReplyShortcut(prefillShortcut);
  if (quickReplyShortcut && normalizedPrefill) {
    quickReplyShortcut.value = normalizedPrefill;
  }

  renderQuickReplyManagerList();
  loadQuickReplies();
  setTimeout(() => {
    if (quickReplyShortcut && !quickReplyShortcut.value) quickReplyShortcut.focus();
    else if (quickReplyTitle && !quickReplyTitle.value) quickReplyTitle.focus();
  }, 30);
}

function closeQuickReplyModal() {
  if (!quickReplyModal) return;
  quickReplyModal.classList.remove("open");
  quickReplyModal.hidden = true;
}

function formatQuickReplyCount(total) {
  return `${total} ${total === 1 ? "atalho" : "atalhos"}`;
}

function renderQuickReplyManagerList() {
  if (!quickReplyManagerList || !quickReplyCount) return;

  quickReplyCount.textContent = formatQuickReplyCount(quickReplies.length);

  if (!quickReplies.length) {
    quickReplyManagerList.innerHTML = `
      <div class="quick-reply-manager-empty">
        <strong>Nenhuma resposta salva ainda</strong>
        <p>Comece criando os atalhos mais repetidos do seu atendimento, como preço, link de pagamento ou prazo.</p>
      </div>
    `;
    return;
  }

  quickReplyManagerList.innerHTML = quickReplies
    .map(reply => `
      <article class="quick-reply-manager-item" data-reply-id="${reply.id}">
        <div class="quick-reply-manager-copy">
          <div class="quick-reply-manager-head">
            <span class="quick-reply-shortcut">/${escapeHtml(reply.shortcut)}</span>
            <strong>${escapeHtml(reply.title)}</strong>
          </div>
          <p>${escapeHtml(buildQuickReplyPreview(reply.content))}</p>
        </div>
        <div class="quick-reply-manager-actions">
          <button type="button" class="quick-reply-use-btn" data-action="use" data-id="${reply.id}">Usar</button>
          <button type="button" class="quick-reply-delete-btn" data-action="delete" data-id="${reply.id}">Excluir</button>
        </div>
      </article>
    `)
    .join("");
}

async function loadQuickReplies() {
  if (quickReplyLoadingPromise) return quickReplyLoadingPromise;

  quickReplyLoadingPromise = fetch("/api/quick-replies", {
    credentials: "include",
  })
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Não foi possível carregar as respostas rápidas.");
      }
      quickReplies = Array.isArray(data?.replies) ? data.replies : [];
      renderQuickReplyManagerList();
      handleQuickReplyInput();
      return quickReplies;
    })
    .catch(err => {
      console.error("Quick replies - load error:", err);
      quickReplies = [];
      renderQuickReplyManagerList();
      handleQuickReplyInput();
      return [];
    })
    .finally(() => {
      quickReplyLoadingPromise = null;
    });

  return quickReplyLoadingPromise;
}

function resetQuickReplyForm() {
  if (quickReplyForm) quickReplyForm.reset();
}

function setQuickReplySaveLoading(isLoading) {
  if (!btnQuickReplySave) return;
  btnQuickReplySave.disabled = isLoading;
  btnQuickReplySave.innerHTML = isLoading
    ? `<i class="fa-solid fa-spinner fa-spin"></i> Salvando...`
    : `<i class="fa-solid fa-floppy-disk"></i> Salvar resposta`;
}

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
   🎨 AVATAR COM INICIAIS (FALLBACK COLORIDO)
   ========================================================== */
const AVATAR_COLORS = [
    "#6C64EF", "#2EE6A6", "#F2994A", "#5AC8FA", "#FF8A65",
    "#8E44AD", "#45AAF2", "#F2C94C", "#26DE81", "#E056FD"
];

function avatarInitials(name) {
    const parts = (name || "Contato").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "??";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(name) {
    const text = (name || "").toLowerCase();
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = text.charCodeAt(i) + ((hash << 5) - hash);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function buildAvatarHtml(chat) {
    const name = chat?.name || "Contato";
    const initials = escapeHtml(avatarInitials(name));
    const color = avatarColor(name);
    const hasPic = !!chat?.pic;
    const safeName = escapeHtml(name);
    const safePic = escapeHtml(chat?.pic || "");

    return `
      <div class="avatar-shell">
        ${hasPic ? `
          <img
            class="avatar avatar-img"
            src="${safePic}"
            alt="${safeName}"
            loading="lazy"
            onerror="this.style.display='none';const f=this.nextElementSibling;if(f){f.classList.remove('hidden');}"
          >
        ` : ""}
        <div class="avatar avatar-fallback ${hasPic ? "hidden" : ""}" style="background:${color};">
          ${initials}
        </div>
      </div>
    `;
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

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function normalizeUserUsage(user) {
    const LIMITS = { free: 500, starter: 500, pro: null };
    const plan = String(user?.plan || "free");
    const rawLimit = user?.planConfig?.maxIaMessages;
    const normalizedRawLimit = String(rawLimit ?? "").trim().toLowerCase();
    const numericLimit = Number(rawLimit);
    const fallbackLimit = Object.prototype.hasOwnProperty.call(LIMITS, plan)
        ? LIMITS[plan]
        : null;
    const limit = normalizedRawLimit === "unlimited"
        ? null
        : Number.isFinite(numericLimit) && numericLimit >= 0
            ? numericLimit
            : fallbackLimit;
    const used = Number(user?.ia_messages_used) || 0;

    return {
        used,
        limit,
        plan,
        planLabel: String(user?.planConfig?.displayName || plan || "Plano"),
    };
}

function getUsageRatio() {
    if (chatUserUsage.limit === null || chatUserUsage.limit <= 0) return 0;
    return Math.min(1, chatUserUsage.used / chatUserUsage.limit);
}

function buildUsageLabel() {
    if (chatUserUsage.limit === null) {
        return `${chatUserUsage.used} / ilimitado no mês`;
    }

    return `${chatUserUsage.used} / ${chatUserUsage.limit} IA no mês`;
}

async function refreshUserUsage(force = false) {
    const now = Date.now();
    if (!force && now - lastUsageRefreshAt < 60_000) return;

    lastUsageRefreshAt = now;

    try {
        const res = await fetch("/auth/me", { credentials: "include" });
        if (!res.ok) return;
        const payload = await res.json();
        chatUserUsage = normalizeUserUsage({
            ...(payload?.user || {}),
            planConfig: payload?.planConfig || null,
        });

        if (currentChat) {
            renderChatContext(currentChat);
        }
    } catch {
        // Mantém o snapshot atual se o refresh falhar
    }
}

function getStagePillMarkup(stage) {
    const stageName = String(stage || "Novo");
    const safeStage = escapeHtml(stageName);
    const stageClass = stageName.replace(/\s+/g, "");
    return `<span class="pipeline-dot pipeline-${stageClass}"></span>${safeStage}`;
}

function formatCurrencyValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    return numeric.toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
        maximumFractionDigits: 0,
    });
}

function formatFollowUpDate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    return new Date(numeric).toLocaleDateString("pt-BR");
}

function renderChatContext(chatId) {
    if (!chatContextBar || !contextCrmPill || !contextStagePill || !contextAiPill || !contextHintMeta || !contextUsageMeta) return;

    const chat = chats[chatId];
    if (!chat) {
        chatContextBar.classList.add("is-idle");
        contextCrmPill.textContent = "CRM: selecione uma conversa";
        contextCrmPill.className = "context-pill context-crm";
        contextStagePill.className = "context-pill context-stage";
        contextStagePill.innerHTML = getStagePillMarkup("Novo");
        contextAiPill.textContent = "IA ON";
        contextAiPill.className = "context-pill context-ai context-ai-on";
        contextHintMeta.textContent = "O contexto do contato aparece aqui sem sair do chat.";
        contextUsageMeta.textContent = buildUsageLabel();
        contextUsageMeta.className = "context-meta context-usage";
        return;
    }

    chatContextBar.classList.remove("is-idle");

    const isGroup = String(chatId).endsWith("@g.us");
    const crmName = String(chat.crmName || chat.name || "Contato").trim();
    const crmFound = chat.crmFound === true;
    const aiOn = chat.ai !== false;
    const stage = isGroup
        ? "Grupo"
        : crmFound
            ? String(chat.pipeline || "Novo")
            : "Sem CRM";
    const citystate = String(chat.citystate || "").trim();
    const dealValue = formatCurrencyValue(chat.dealValue);
    const followUpDate = formatFollowUpDate(chat.followUpDate);
    const tags = getContactTagsForChat(chatId);
    const usageRatio = getUsageRatio();

    contextCrmPill.textContent = isGroup
        ? `Grupo: ${crmName}`
        : crmFound
            ? `CRM: ${crmName}`
            : `Sem CRM: ${crmName}`;
    contextCrmPill.className = `context-pill context-crm ${crmFound ? "context-linked" : "context-unlinked"}`;

    contextStagePill.className = "context-pill context-stage";
    contextStagePill.innerHTML = getStagePillMarkup(stage);

    contextAiPill.textContent = aiOn ? "IA ON" : "IA OFF";
    contextAiPill.className = `context-pill context-ai ${aiOn ? "context-ai-on" : "context-ai-off"}`;

    const hintParts = [];
    if (isGroup) {
        hintParts.push("Conversa em grupo");
    } else if (crmFound) {
        hintParts.push("Contato vinculado ao CRM");
    } else {
        hintParts.push("Contato ainda não cadastrado no CRM");
    }
    if (citystate) hintParts.push(citystate);
    if (dealValue) hintParts.push(`Negócio ${dealValue}`);
    if (followUpDate) hintParts.push(`Follow-up ${followUpDate}`);
    if (tags.length) {
        const summary = tags.slice(0, 2).join(", ");
        hintParts.push(tags.length > 2 ? `Tags: ${summary} +${tags.length - 2}` : `Tags: ${summary}`);
    }

    contextHintMeta.textContent = hintParts.join(" • ");
    contextUsageMeta.textContent = buildUsageLabel();
    contextUsageMeta.className = "context-meta context-usage";
    if (chatUserUsage.limit !== null) {
        if (usageRatio >= 0.9) {
            contextUsageMeta.classList.add("usage-danger");
        } else if (usageRatio >= 0.7) {
            contextUsageMeta.classList.add("usage-warning");
        } else {
            contextUsageMeta.classList.add("usage-ok");
        }
    } else {
        contextUsageMeta.classList.add("usage-unlimited");
    }
}

async function loadChatContext(chatId) {
    if (!chatId || !chats[chatId]) return;

    renderChatContext(chatId);
    refreshUserUsage();

    if (String(chatId).endsWith("@g.us")) {
        chats[chatId].crmFound = false;
        chats[chatId].crmName = chats[chatId].name;
        chats[chatId].pipeline = "Grupo";
        chats[chatId].tags = [];
        updateContactTagButtonState();
        renderChatContext(chatId);
        return;
    }

    try {
        const res = await fetch(`/api/crm/client/${encodeURIComponent(chatId)}`);
        if (!res.ok) throw new Error("Falha ao carregar contexto CRM");
        const data = await res.json();

        chats[chatId].crmFound = data?.found === true;
        chats[chatId].crmName = data?.crmName || chats[chatId].name;
        chats[chatId].pipeline = data?.pipeline || "Novo";
        chats[chatId].citystate = data?.citystate || "";
        chats[chatId].dealValue = data?.dealValue ?? null;
        chats[chatId].followUpDate = data?.followUpDate ?? null;
        if (Array.isArray(data?.tags)) {
            setContactTagsForChat(chatId, data.tags);
        }
    } catch {
        chats[chatId].crmFound = false;
        chats[chatId].crmName = chats[chatId].name;
        chats[chatId].pipeline = chats[chatId].pipeline || "Novo";
    }

    if (currentChat === chatId) {
        updateContactTagButtonState();
        renderChatContext(chatId);
    }
}

function formatNoteDate(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.toLocaleString();
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
            crmFound: false,
            crmName: name || chatId.replace("@c.us", ""),
            citystate: "",
            dealValue: null,
            followUpDate: null,
            tags: [],
            lastMsg: null,  // { body, fromMe, timestamp, isMedia, mimetype }
            unread: 0       // contador de mensagens não lidas
        };
    }

    chats[chatId].tags = getContactTagsForChat(chatId);
}

function appendInternalSystemNote(note) {
    const chatId = note?.chatId;
    if (!chatId) return;

    const body = String(note.message || note.body || "").trim();
    if (!body) return;

    ensureChat(chatId, note.name);

    chats[chatId].msgs.push({
        body,
        timestamp: note.timestamp || note.triggeredAt || Date.now(),
        fromBot: true,
        system: true,
        systemNote: true,
        noteTitle: String(note.title || "Nota interna"),
        noteDetail: note.detail ? String(note.detail) : "",
        noteType: String(note.type || "system"),
    });

    if (currentChat === chatId) {
        renderMessages(chatId);
    }

    renderChatList();
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

function normalizeContactPhone(raw) {
    return String(raw || "")
        .trim()
        .replace(/@.*/, "")
        .replace(/\D/g, "");
}

function normalizeTagKey(tag) {
    return String(tag || "")
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function getContactTagPreset(tag) {
    const key = normalizeTagKey(tag);
    return CONTACT_TAG_PRESETS.find((item) => normalizeTagKey(item.label) === key) || null;
}

function sortContactTags(tags) {
    const list = Array.isArray(tags) ? tags : [];
    const unique = [];
    const seen = new Set();

    list.forEach((tag) => {
        const clean = String(tag || "").trim();
        const key = normalizeTagKey(clean);
        if (!clean || seen.has(key)) return;
        seen.add(key);
        unique.push(clean);
    });

    return unique.sort((a, b) => {
        const presetIndexA = CONTACT_TAG_PRESETS.findIndex((item) => normalizeTagKey(item.label) === normalizeTagKey(a));
        const presetIndexB = CONTACT_TAG_PRESETS.findIndex((item) => normalizeTagKey(item.label) === normalizeTagKey(b));
        const normalizedPresetA = presetIndexA === -1 ? Number.MAX_SAFE_INTEGER : presetIndexA;
        const normalizedPresetB = presetIndexB === -1 ? Number.MAX_SAFE_INTEGER : presetIndexB;
        if (normalizedPresetA !== normalizedPresetB) return normalizedPresetA - normalizedPresetB;
        return a.localeCompare(b, "pt-BR");
    });
}

function getContactTagsForChat(chatId) {
    const phone = normalizeContactPhone(chatId);
    if (!phone) return [];
    return sortContactTags(window.CONTACT_TAGS?.[phone] || []);
}

function setContactTagsForChat(chatId, tags) {
    const phone = normalizeContactPhone(chatId);
    if (!phone) return [];

    const normalizedTags = sortContactTags(tags);
    window.CONTACT_TAGS[phone] = normalizedTags;

    Object.keys(chats).forEach((id) => {
        if (normalizeContactPhone(id) === phone && chats[id]) {
            chats[id].tags = [...normalizedTags];
        }
    });

    return normalizedTags;
}

function collectAvailableContactTags() {
    const entries = Object.values(window.CONTACT_TAGS || {}).flatMap((list) => Array.isArray(list) ? list : []);
    return sortContactTags(entries);
}

function buildContactTagChip(tag, options = {}) {
    const preset = getContactTagPreset(tag);
    const tone = preset?.tone || "custom";
    const activeClass = options.active ? " is-active" : "";
    const compactClass = options.compact ? " tag-chip-compact" : "";
    return `<span class="tag-chip tag-chip-${tone}${activeClass}${compactClass}">${escapeHtml(tag)}</span>`;
}

function renderChatTagFilters() {
    if (!chatTagFilters) return;

    const availableTags = collectAvailableContactTags();
    if (!availableTags.length) {
        activeContactTagFilter = "";
        chatTagFilters.innerHTML = `<div class="chat-tag-filters-empty">Sem tags ainda</div>`;
        return;
    }

    const allButtonClass = activeContactTagFilter ? "chat-tag-filter" : "chat-tag-filter is-active";
    const buttons = availableTags.map((tag) => {
        const isActive = normalizeTagKey(activeContactTagFilter) === normalizeTagKey(tag);
        const preset = getContactTagPreset(tag);
        const toneClass = preset ? ` chat-tag-filter-${preset.tone}` : " chat-tag-filter-custom";
        return `
          <button
            type="button"
            class="chat-tag-filter${toneClass}${isActive ? " is-active" : ""}"
            data-filter-tag="${escapeHtml(tag)}"
          >${escapeHtml(tag)}</button>
        `;
    }).join("");

    chatTagFilters.innerHTML = `
      <button type="button" class="${allButtonClass}" data-filter-tag="">Todos</button>
      ${buttons}
    `;
}

function updateContactTagButtonState() {
    if (!btnContactTags) return;

    const chatId = currentChat;
    const isGroup = chatId ? /@g\.us$/i.test(chatId) : false;
    const tags = chatId ? getContactTagsForChat(chatId) : [];
    const disabled = !chatId || isGroup;

    btnContactTags.disabled = disabled;
    btnContactTags.classList.toggle("has-tags", tags.length > 0);
    if (disabled) {
        btnContactTags.classList.remove("active");
    }

    const labelEl = btnContactTags.querySelector(".btn-tag-text");
    if (labelEl) {
        labelEl.textContent = tags.length > 0 ? `Tags (${tags.length})` : "Tags";
    }
}

function isContactTagDropdownOpen() {
    return Boolean(contactTagDropdown && !contactTagDropdown.hidden);
}

function hideContactTagDropdown() {
    if (contactTagDropdown) contactTagDropdown.hidden = true;
    btnContactTags?.classList.remove("active");
}

function renderContactTagDropdown() {
    if (!contactTagDropdownTitle || !contactTagDropdownList || !contactTagDropdownHint) return;

    if (!currentChat || !chats[currentChat]) {
        contactTagDropdownTitle.textContent = "Selecione um contato";
        contactTagDropdownList.innerHTML = "";
        contactTagDropdownHint.textContent = "Abra uma conversa para classificar o contato.";
        return;
    }

    if (/@g\.us$/i.test(currentChat)) {
        contactTagDropdownTitle.textContent = chats[currentChat].name || "Grupo";
        contactTagDropdownList.innerHTML = "";
        contactTagDropdownHint.textContent = "Tags rápidas ficam disponíveis apenas para contatos individuais.";
        return;
    }

    const activeTags = getContactTagsForChat(currentChat);
    const allOptions = sortContactTags([
        ...CONTACT_TAG_PRESETS.map((item) => item.label),
        ...activeTags,
    ]);

    contactTagDropdownTitle.textContent = chats[currentChat].name || "Contato";
    contactTagDropdownList.innerHTML = allOptions.map((tag) => {
        const active = activeTags.some((item) => normalizeTagKey(item) === normalizeTagKey(tag));
        const preset = getContactTagPreset(tag);
        const toneClass = preset ? ` contact-tag-option-${preset.tone}` : " contact-tag-option-custom";
        return `
          <button
            type="button"
            class="contact-tag-option${toneClass}${active ? " is-active" : ""}"
            data-contact-tag="${escapeHtml(tag)}"
            aria-pressed="${active ? "true" : "false"}"
          >
            <span>${escapeHtml(tag)}</span>
            <i class="fa-solid ${active ? "fa-check" : "fa-plus"}"></i>
          </button>
        `;
    }).join("");

    contactTagDropdownHint.textContent = activeTags.length
        ? "Clique em uma tag ativa para remover. As alterações refletem na lista imediatamente."
        : "Marque o contato para destacar prioridade na sidebar e filtrar mais rápido.";
}

function toggleContactTagDropdown(forceOpen) {
    if (!contactTagDropdown || !btnContactTags || btnContactTags.disabled) return;

    const shouldOpen = typeof forceOpen === "boolean"
        ? forceOpen
        : contactTagDropdown.hidden;

    if (!shouldOpen) {
        hideContactTagDropdown();
        return;
    }

    renderContactTagDropdown();
    contactTagDropdown.hidden = false;
    btnContactTags.classList.add("active");
}

async function loadContactTags(force = false) {
    if (!force && contactTagLoadingPromise) {
        return contactTagLoadingPromise;
    }

    contactTagLoadingPromise = (async () => {
        try {
            const res = await fetch("/api/contact-tags", {
                credentials: "include",
            });
            if (!res.ok) throw new Error("Falha ao carregar tags");
            const data = await res.json();
            window.CONTACT_TAGS = data?.tagsByPhone || {};

            Object.keys(chats).forEach((chatId) => {
                chats[chatId].tags = getContactTagsForChat(chatId);
            });

            const available = collectAvailableContactTags();
            if (activeContactTagFilter && !available.some((tag) => normalizeTagKey(tag) === normalizeTagKey(activeContactTagFilter))) {
                activeContactTagFilter = "";
            }

            renderChatTagFilters();
            renderChatList(searchBox?.value || "");
            updateContactTagButtonState();
            if (isContactTagDropdownOpen()) {
                renderContactTagDropdown();
            }
        } catch (err) {
            console.warn("Não foi possível carregar tags dos contatos:", err);
            renderChatTagFilters();
        } finally {
            contactTagLoadingPromise = null;
        }
    })();

    return contactTagLoadingPromise;
}

async function toggleCurrentContactTag(tag) {
    if (!currentChat || !chats[currentChat] || /@g\.us$/i.test(currentChat)) return;

    const phone = normalizeContactPhone(currentChat);
    if (!phone) return;

    const currentTags = getContactTagsForChat(currentChat);
    const isActive = currentTags.some((item) => normalizeTagKey(item) === normalizeTagKey(tag));
    const method = isActive ? "DELETE" : "POST";

    const res = await fetch(`/api/contact-tags/${encodeURIComponent(phone)}`, {
        method,
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            tag,
            chatId: currentChat,
            name: chats[currentChat]?.name || phone,
        }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Não foi possível atualizar a tag do contato.");
    }

    const tags = setContactTagsForChat(currentChat, data?.tags || []);
    renderChatTagFilters();
    renderChatList(searchBox?.value || "");
    updateContactTagButtonState();
    renderContactTagDropdown();
    if (currentChat) {
        renderChatContext(currentChat);
    }
    return tags;
}

function handleContactTagsChanged(payload) {
    const phone = normalizeContactPhone(payload?.phone || payload?.chatId);
    if (!phone) return;

    const chatId = payload?.chatId || `${phone}@c.us`;
    setContactTagsForChat(chatId, payload?.tags || []);

    const available = collectAvailableContactTags();
    if (activeContactTagFilter && !available.some((tag) => normalizeTagKey(tag) === normalizeTagKey(activeContactTagFilter))) {
        activeContactTagFilter = "";
    }

    renderChatTagFilters();
    renderChatList(searchBox?.value || "");
    updateContactTagButtonState();

    if (currentChat && normalizeContactPhone(currentChat) === phone) {
        renderChatContext(currentChat);
        if (isContactTagDropdownOpen()) {
            renderContactTagDropdown();
        }
    }
}

/* ==========================================================
   🎨 RENDERIZAR LISTA DE CHATS
   ========================================================== */
function renderChatList(filter = "") {
    const cont = document.getElementById("chatlist");
    cont.innerHTML = "";
    const nameFilter = String(filter || "").toLowerCase();
    const activeTagKey = normalizeTagKey(activeContactTagFilter);

    Object.keys(chats).forEach(id => {
        const chatName = String(chats[id].name || "");
        if (nameFilter && !chatName.toLowerCase().includes(nameFilter)) return;

        const contactTags = getContactTagsForChat(id);
        chats[id].tags = contactTags;
        if (activeTagKey && !contactTags.some((tag) => normalizeTagKey(tag) === activeTagKey)) {
            return;
        }

        const div = document.createElement("div");
        div.className =
            "chat-item" +
            (id === currentChat ? " active" : "") +
            (chats[id].human ? " chat-human" : "") +
            (chats[id].ai === false ? " chat-ai-off" : "");

        div.dataset.chatId = id;
        div.onclick = () => selectChat(id);

        const chatDraft = id === currentChat && inputMsg ? inputMsg.value : getDraftForChat(id);
        const draftPreview = getDraftPreviewText(chatDraft);
        const hasDraft = Boolean(draftPreview);
        const preview = hasDraft ? draftPreview : getLastMsgPreview(chats[id]);
        const lastTime = fmtLastTime(chats[id].lastMsg?.timestamp);
        const unread = chats[id].unread || 0;
        const avatar = buildAvatarHtml(chats[id]);
        const safeName = escapeHtml(chatName || "Sem nome");
        const safePreview = escapeHtml(preview);
        const safeLastTime = escapeHtml(lastTime);
        const safeUnread = unread > 99 ? "99+" : String(unread);
        const tagsMarkup = contactTags.length
            ? `
              <div class="c-tags">
                ${contactTags.slice(0, 2).map((tag) => buildContactTagChip(tag, { compact: true })).join("")}
                ${contactTags.length > 2 ? `<span class="chat-tag-more">+${contactTags.length - 2}</span>` : ""}
              </div>
            `
            : "";

        div.innerHTML = `
            ${avatar}
            <div class="chat-infos">
                <div class="chat-name-row">
                    <div class="chat-name">${safeName}</div>
                    <div class="chat-time">${safeLastTime}</div>
                </div>
                <div class="chat-preview-row">
                    <div class="chat-preview${hasDraft ? " draft-preview" : ""}">${hasDraft ? `<span class="draft-preview-label">Rascunho:</span> ${safePreview}` : safePreview}</div>
                    ${unread > 0 ? `<div class="chat-unread">${safeUnread}</div>` : ""}
                </div>
                ${tagsMarkup}
            </div>
        `;
        cont.appendChild(div);
    });
}

/* ==========================================================
   📌 SELECIONAR CHAT + RECARREGAR MODO HUMANO + TIMER
   ========================================================== */
async function selectChat(chatId) {
  const previousChat = currentChat;
  const isSameChat = previousChat === chatId;
  if (previousChat && !isSameChat) {
    saveComposerDraft(previousChat);
  }

  hideQuickReplyDropdown();
  hideContactTagDropdown();
  currentChat = chatId;

  // Fechar sidebar no mobile ao selecionar chat
  closeSidebar();

  // Solicita mensagens ao servidor
  if (!pendingChatLoads.has(chatId)) {
    pendingChatLoads.add(chatId);
    socket.emit("abrir_chat", chatId);
  }

    // Zerar contador de não lidas ao abrir o chat
    if (chats[chatId]) {
        chats[chatId].unread = 0;
        refreshChatListView();
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
    updateContactTagButtonState();

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
    renderChatContext(chatId);

    // Notas internas (se painel estiver aberto)
    if (notesVisible) {
        await loadNotes(chatId);
    }

    // Renderizar mensagens
    renderMessages(chatId);
    if (!isSameChat) {
        restoreDraftForChat(chatId);
    }

    // Pipeline/CRM + uso IA no contexto integrado
    await loadChatContext(chatId);

    // Notas internas
    await loadNotes(chatId);
}

btnQuickReplyManage?.addEventListener("click", () => {
  openQuickReplyModal(extractQuickReplyQuery(inputMsg?.value || ""));
});

btnQuickReplyCreateEmpty?.addEventListener("click", () => {
  openQuickReplyModal(extractQuickReplyQuery(inputMsg?.value || ""));
});

btnQuickReplyClose?.addEventListener("click", closeQuickReplyModal);

quickReplyModal?.addEventListener("click", event => {
  const target = event.target;
  if (target instanceof HTMLElement && target.hasAttribute("data-quick-reply-close")) {
    closeQuickReplyModal();
  }
});

quickReplyManagerList?.addEventListener("click", async event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const actionButton = target.closest("[data-action]");
  if (!(actionButton instanceof HTMLElement)) return;

  const replyId = Number(actionButton.dataset.id || 0);
  const reply = quickReplies.find(item => Number(item.id) === replyId);
  if (!reply) return;

  const action = String(actionButton.dataset.action || "");
  if (action === "use") {
    applyQuickReply(reply);
    closeQuickReplyModal();
    return;
  }

  if (action === "delete") {
    const confirmed = window.confirm(`Excluir o atalho /${reply.shortcut}?`);
    if (!confirmed) return;

    actionButton.setAttribute("disabled", "disabled");

    try {
      const res = await fetch(`/api/quick-replies/${reply.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Não foi possível excluir a resposta rápida.");
      }

      quickReplies = quickReplies.filter(item => Number(item.id) !== reply.id);
      renderQuickReplyManagerList();
      handleQuickReplyInput();
    } catch (err) {
      console.error("Quick replies - delete error:", err);
      alert(err?.message || "Não foi possível excluir a resposta rápida.");
      actionButton.removeAttribute("disabled");
    }
  }
});

quickReplyForm?.addEventListener("submit", async event => {
  event.preventDefault();

  const payload = {
    shortcut: quickReplyShortcut?.value || "",
    title: quickReplyTitle?.value || "",
    content: quickReplyContent?.value || "",
  };

  setQuickReplySaveLoading(true);

  try {
    const res = await fetch("/api/quick-replies", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || "Não foi possível salvar a resposta rápida.");
    }

    resetQuickReplyForm();
    await loadQuickReplies();
    if (quickReplyShortcut) quickReplyShortcut.focus();
  } catch (err) {
    console.error("Quick replies - save error:", err);
    alert(err?.message || "Não foi possível salvar a resposta rápida.");
  } finally {
    setQuickReplySaveLoading(false);
  }
});

btnContactTags?.addEventListener("click", event => {
  event.stopPropagation();
  toggleContactTagDropdown();
});

contactTagDropdownList?.addEventListener("click", async event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const option = target.closest("[data-contact-tag]");
  if (!(option instanceof HTMLElement)) return;

  const tag = String(option.dataset.contactTag || "").trim();
  if (!tag) return;

  option.setAttribute("disabled", "disabled");
  try {
    await toggleCurrentContactTag(tag);
  } catch (err) {
    console.error("Contact tags - toggle error:", err);
    alert(err?.message || "Não foi possível atualizar a tag do contato.");
  } finally {
    option.removeAttribute("disabled");
  }
});

chatTagFilters?.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest("[data-filter-tag]");
  if (!(button instanceof HTMLElement)) return;

  const nextTag = String(button.dataset.filterTag || "").trim();
  const isSameTag = normalizeTagKey(nextTag) === normalizeTagKey(activeContactTagFilter);
  activeContactTagFilter = isSameTag ? "" : nextTag;
  renderChatTagFilters();
  renderChatList(searchBox?.value || "");
});

chatTagFilters?.addEventListener("dblclick", () => {
  if (!activeContactTagFilter) return;
  activeContactTagFilter = "";
  renderChatTagFilters();
  renderChatList(searchBox?.value || "");
});

document.addEventListener("click", event => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const insideFooter = Boolean(target.closest(".chat-footer"));
  const insideModal = Boolean(target.closest(".quick-reply-modal-card"));
  const insideContactTagDropdown = Boolean(target.closest(".contact-tag-dropdown"));
  const insideContactTagButton = Boolean(target.closest("#btnContactTags"));

  if (!insideFooter && !insideModal) {
    hideQuickReplyDropdown();
  }

  if (!insideContactTagDropdown && !insideContactTagButton) {
    hideContactTagDropdown();
  }
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && quickReplyModal?.classList.contains("open")) {
    closeQuickReplyModal();
  }

  if (event.key === "Escape" && isContactTagDropdownOpen()) {
    hideContactTagDropdown();
  }
});

/* ==========================================================
   💬 RENDERIZAR MENSAGENS + MIDIAS
   ========================================================== */
function fmtTime(ts) {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

const MESSAGE_STATUS_ORDER = {
    sent: 1,
    delivered: 2,
    read: 3,
};

function normalizeMessageId(value) {
    const direct =
        typeof value === "string"
            ? value
            : value?._serialized ||
              value?.id?._serialized ||
              value?.id ||
              value?.messageId ||
              value?.msgId ||
              null;

    const text = String(direct || "").trim();
    return text || null;
}

function normalizeMessageStatus(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "read") return "read";
    if (text === "delivered") return "delivered";
    if (text === "sent") return "sent";
    return null;
}

function resolveOutgoingMessageStatus(msg) {
    const explicit = normalizeMessageStatus(msg?.deliveryStatus || msg?.status);
    if (explicit) return explicit;

    const ack = Number(msg?.ack);
    if (Number.isFinite(ack)) {
        if (ack >= 3) return "read";
        if (ack === 2) return "delivered";
        if (ack >= 1) return "sent";
    }

    return null;
}

function shouldUpgradeMessageStatus(currentStatus, nextStatus) {
    const currentOrder = MESSAGE_STATUS_ORDER[normalizeMessageStatus(currentStatus)] || 0;
    const nextOrder = MESSAGE_STATUS_ORDER[normalizeMessageStatus(nextStatus)] || 0;
    return nextOrder > currentOrder;
}

function buildMessageStatusText(status) {
    return status === "sent" ? "✓" : "✓✓";
}

function buildMessageStatusClass(status) {
    if (status === "read") return "msg-status msg-read";
    if (status === "delivered") return "msg-status msg-delivered";
    return "msg-status";
}

function updateMessageStatusInMemory(chatId, msgId, status) {
    const normalizedId = normalizeMessageId(msgId);
    const normalizedStatus = normalizeMessageStatus(status);
    if (!chatId || !normalizedId || !normalizedStatus || !Array.isArray(chats[chatId]?.msgs)) return false;

    let updated = false;
    chats[chatId].msgs.forEach((msg) => {
        const currentId = normalizeMessageId(msg?.messageId || msg?.id || msg?.msgId);
        if (currentId !== normalizedId) return;

        const currentStatus = resolveOutgoingMessageStatus(msg);
        if (!shouldUpgradeMessageStatus(currentStatus, normalizedStatus)) return;

        msg.messageId = normalizedId;
        msg.id = normalizedId;
        msg.deliveryStatus = normalizedStatus;
        msg.status = normalizedStatus;
        msg.ack = normalizedStatus === "read" ? 3 : normalizedStatus === "delivered" ? 2 : 1;
        updated = true;
    });

    return updated;
}

function updateMessageStatusInDom(chatId, msgId, status) {
    if (currentChat !== chatId) return;

    const normalizedId = normalizeMessageId(msgId);
    const normalizedStatus = normalizeMessageStatus(status);
    if (!normalizedId || !normalizedStatus) return;

    document.querySelectorAll(".msg-status").forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.dataset.msgid !== normalizedId) return;

        node.dataset.status = normalizedStatus;
        node.className = buildMessageStatusClass(normalizedStatus);
        node.textContent = buildMessageStatusText(normalizedStatus);
    });
}

function fmtDateLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();

    if (sameDay(d, today)) return "Hoje";
    if (sameDay(d, yesterday)) return "Ontem";
    return d.toLocaleDateString("pt-BR");
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

    let lastDateKey = null;

    chats[chatId].msgs.forEach((msg, idx) => {
        msg.timestamp = msg.timestamp || Date.now();
        const fromMe = resolveIsFromMe(msg);
        const dateKey = new Date(msg.timestamp).toDateString();

        // Divider de data (estilo WhatsApp)
        if (dateKey !== lastDateKey) {
            const divider = document.createElement("div");
            divider.className = "msg-divider";
            divider.innerHTML = `<span>${fmtDateLabel(msg.timestamp)}</span>`;
            box.appendChild(divider);
            lastDateKey = dateKey;
        }

        const row = document.createElement("div");
        const isSystemNote = msg.systemNote === true;
        const isSystem = msg.system === true;
        row.className = "msg-row " + (isSystemNote ? "system-note-row" : (isSystem ? "system-msg" : (fromMe ? "from-user" : "from-bot")));
        row.dataset.msgIdx = idx;

        const bubble = document.createElement("div");
        let appendDefaultMeta = true;

        if (isSystemNote) {
            bubble.className = "system-note-card";
            bubble.innerHTML = `
                <div class="system-note-title">${escapeHtml(msg.noteTitle || "Nota interna")}</div>
                <div class="system-note-body">${escapeHtml(msg.body || "")}</div>
                ${msg.noteDetail ? `<div class="system-note-detail">${escapeHtml(msg.noteDetail)}</div>` : ""}
                <div class="system-note-time">${escapeHtml(fmtTime(msg.timestamp))}</div>
            `;
            appendDefaultMeta = false;
        } else {
            bubble.className = "msg-bubble";
        }

        if (isSystemNote) {
            // layout já montado acima
        } else if (isSystem) {
            bubble.textContent = msg.body || "";
        } else if (msg.isMedia || msg.mimetype) {
            msg.isMedia = true;
            const mime = msg.mimetype || "";
            const mediaBase64 = msg.mediaBase64 || msg.body || "";
            const safeMime = escapeHtml(mime);
            const safeMediaText = escapeHtml(msg.mediaText || "");

            if (mime.startsWith("image/")) {
                row.classList.add("msg-photo");
                bubble.classList.add("msg-bubble-media");
                bubble.innerHTML = `
                    <img class="msg-img" src="data:${safeMime};base64,${mediaBase64}" alt="imagem enviada">
                `;
            } else if (mime.startsWith("audio/") || mime.includes("opus")) {
                row.classList.add("msg-audio-row");
                bubble.classList.add("msg-bubble-media", "msg-audio-card");

                // Pequena forma de onda estática para diferenciação visual
                const bars = Array.from({ length: 16 }).map((_, i) => `<span style="--i:${i};"></span>`).join("");

                bubble.innerHTML = `
                    <div class="audio-card">
                        <div class="audio-wave">${bars}</div>
                        <audio controls class="msg-audio">
                            <source src="data:${safeMime};base64,${mediaBase64}" type="${safeMime}">
                        </audio>
                        ${msg.mediaText ? `<p class="audio-caption">${safeMediaText}</p>` : ""}
                    </div>
                `;
            } else if (mime.startsWith("video/")) {
                row.classList.add("msg-video-row");
                bubble.classList.add("msg-bubble-media");
                bubble.innerHTML = `<video controls class="msg-video" src="data:${safeMime};base64,${mediaBase64}"></video>`;
            } else {
                row.classList.add("msg-doc-row");
                bubble.classList.add("msg-doc-card");
                const filename = msg.filename || "Documento";
                const fileType = (mime.split("/")[1] || "file").toUpperCase();
                bubble.innerHTML = `
                    <div class="doc-card">
                        <div class="doc-icon">${escapeHtml(fileType.slice(0, 3))}</div>
                        <div class="doc-body">
                            <div class="doc-name">${escapeHtml(filename)}</div>
                            <div class="doc-meta">${safeMime || "Arquivo"}</div>
                            <a class="doc-download" download href="data:${safeMime};base64,${msg.body}">⬇ Baixar</a>
                        </div>
                    </div>
                `;
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

        if (appendDefaultMeta) {
            const meta = document.createElement("div");
            meta.className = "meta";
            const time = document.createElement("span");
            time.textContent = fmtTime(msg.timestamp);
            meta.appendChild(time);

            if (!isSystem && fromMe) {
                const status = resolveOutgoingMessageStatus(msg) || "sent";
                const messageId = normalizeMessageId(msg?.messageId || msg?.id || msg?.msgId);
                const statusNode = document.createElement("span");
                statusNode.className = buildMessageStatusClass(status);
                statusNode.textContent = buildMessageStatusText(status);
                statusNode.dataset.status = status;
                if (messageId) {
                    statusNode.dataset.msgid = messageId;
                }
                meta.appendChild(statusNode);
            }

            bubble.appendChild(meta);
        }

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
   🗒️ NOTAS INTERNAS (PAINEL)
   ========================================================== */
function renderNotes(chatId) {
    if (!notesList || !notesCount) return;
    const list = chatNotes[chatId] || [];
    notesCount.textContent = String(list.length);

    notesList.innerHTML = "";
    if (list.length === 0) {
        notesList.classList.add("empty");
        notesList.textContent = "Nenhuma nota interna ainda.";
        return;
    }

    notesList.classList.remove("empty");

    list.forEach(note => {
        const item = document.createElement("div");
        item.className = "note-item";
        const meta = document.createElement("div");
        meta.className = "note-meta";
        const author = document.createElement("span");
        author.textContent = note.author_name || "Atendente";
        const when = document.createElement("span");
        when.textContent = formatNoteDate(note.created_at);
        meta.appendChild(author);
        meta.appendChild(when);

        const body = document.createElement("div");
        body.className = "note-body";
        body.innerHTML = escapeHtml(note.content || "");

        item.appendChild(meta);
        item.appendChild(body);
        notesList.appendChild(item);
    });
}

async function loadNotes(chatId) {
    if (!chatId || !window.SESSION_NAME) return;
    if (!notesList) return;
    try {
        const res = await fetch(`/api/chat/notes?chatId=${encodeURIComponent(chatId)}&sessionName=${encodeURIComponent(window.SESSION_NAME)}`);
        const data = await res.json();
        if (data?.ok) {
            chatNotes[chatId] = data.notes || [];
            renderNotes(chatId);
        } else {
            throw new Error(data?.error || "Erro ao carregar notas");
        }
    } catch (err) {
        console.error("Notas - load error:", err);
        notesList.innerHTML = "Erro ao carregar notas";
        notesList.classList.remove("empty");
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

    setDraftForChat(currentChat, "");
    hideDraftBanner();
    inputMsg.value = "";
    hideQuickReplyDropdown();
    resizeInput();
    refreshChatListView();
    setTimeout(() => renderMessages(currentChat), 40);
});

btnDraftDiscard?.addEventListener("click", discardCurrentDraft);
window.addEventListener("beforeunload", () => {
    if (currentChat) {
        saveComposerDraft(currentChat);
    }
});

inputMsg.addEventListener("keydown", e => {
    if (e.key === "Escape" && isQuickReplyDropdownOpen()) {
        e.preventDefault();
        hideQuickReplyDropdown();
        return;
    }

    if (isQuickReplyDropdownOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        moveQuickReplySelection(e.key === "ArrowDown" ? 1 : -1);
        return;
    }

    if (isQuickReplyDropdownOpen() && (e.key === "Enter" || e.key === "Tab") && quickReplyMatches.length) {
        e.preventDefault();
        applyQuickReply(quickReplyMatches[quickReplyActiveIndex] || quickReplyMatches[0]);
        return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        btnSend.click();
    }
});

/* ==========================================================
   🗒️ FORMULÁRIO DE NOTAS INTERNAS
   ========================================================== */
if (noteForm) {
    noteForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!currentChat) return;
        const text = (noteInput?.value || "").trim();
        if (!text) return;

        if (noteSubmit) {
            setButtonLoading(noteSubmit, true, "Salvando...");
        }

        try {
            const res = await fetch("/api/chat/notes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chatId: currentChat,
                    sessionName: window.SESSION_NAME,
                    content: text
                })
            });
            const data = await res.json();
            if (data?.ok) {
                chatNotes[currentChat] = data.notes || [];
                noteInput.value = "";
                renderNotes(currentChat);
            } else {
                alert(data?.error || "Erro ao salvar nota");
            }
        } catch (err) {
            console.error("Notas - save error:", err);
            alert("Erro ao salvar nota");
        } finally {
            if (noteSubmit) {
                setButtonLoading(noteSubmit, false);
            }
        }
    });
}

if (notesRefresh) {
    notesRefresh.addEventListener("click", () => {
        if (!currentChat) return;
        loadNotes(currentChat);
    });
}

if (btnNotesToggle && notesPanel) {
    const setNotesVisible = (visible) => {
        notesVisible = !!visible;
        notesPanel.classList.toggle("hidden", !notesVisible);
        btnNotesToggle.classList.toggle("active", notesVisible);
        btnNotesToggle.textContent = notesVisible ? "🗒️ Notas (aberto)" : "🗒️ Notas";
        if (notesVisible && currentChat) {
            loadNotes(currentChat);
        }
    };

    btnNotesToggle.addEventListener("click", () => {
        setNotesVisible(!notesVisible);
    });
}

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
    if (currentChat === chatId) {
        renderChatContext(chatId);
    }
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
loadQuickReplies();
loadContactTags();

// Abrir chat direto se vier ?contact= na URL (ex: vindo do CRM)
const contactParam = new URLSearchParams(window.location.search).get("contact");

socket.on("lista_chats", lista => {
    lista.forEach(chat => {
        const id = chat.id?._serialized || chat.id;
        ensureChat(id, extrairNome(chat));
        chats[id].human = chat.human === true;
        chats[id].ai = chat.ai;
        chats[id].expire = chat.expire || null;
        if (chat.avatar) {
            chats[id].pic = chat.avatar;
        }
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
        return;
    }

    // Se não veio contactParam e nenhum chat está aberto, abra o primeiro disponível
    if (!currentChat && lista.length > 0) {
        const first = lista[0];
        const firstId = first.id?._serialized || first.id;
        selectChat(firstId);
    }
});

socket.on("mensagens_chat", payload => {
    const chatId = payload?.chatId;
    const msgs = payload?.messages || [];
    if (!chatId) return;
    pendingChatLoads.delete(chatId);
    ensureChat(chatId);
    chats[chatId].msgs = msgs.map((msg) => {
        const messageId = normalizeMessageId(msg?.messageId || msg?.id || msg?.msgId);
        const deliveryStatus = resolveOutgoingMessageStatus(msg);
        return {
            ...msg,
            messageId: messageId || msg?.messageId || null,
            id: messageId || msg?.id || null,
            deliveryStatus: deliveryStatus || msg?.deliveryStatus || null,
        };
    });

    // Atualizar preview com a última mensagem do histórico
    if (msgs && msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        chats[chatId].lastMsg = {
            body: last.body,
            fromMe: resolveIsFromMe(last),
            timestamp: last.timestamp,
            isMedia: last.isMedia || !!last.mimetype,
            mimetype: last.mimetype || ""
        };
        renderChatList();
    }

    // Garantir que o status da IA por chat seja atualizado junto
    socket.emit("chat_ai_state_request", chatId);

    if (currentChat === chatId) {
        renderMessages(chatId);
    }
});

socket.on("abrir_chat_error", payload => {
    const chatId = payload?.chatId;
    if (chatId) {
        pendingChatLoads.delete(chatId);
    }
    console.warn("Falha ao abrir chat:", payload);
});

socket.on("profilePic", data => {
    if (!data.chatId) return;
    ensureChat(data.chatId);
    chats[data.chatId].pic = data.url;
    renderChatList();
});

socket.on("newMessage", msg => {
    ensureChat(msg.chatId, msg.name);
    if (msg.avatar) {
        chats[msg.chatId].pic = msg.avatar;
    }
    msg.isMedia = msg.isMedia || !!msg.mimetype;
    msg.timestamp = msg.timestamp || Date.now();
    msg._isFromMe = resolveIsFromMe(msg) || msg.fromBot === true;
    msg.messageId = normalizeMessageId(msg?.messageId || msg?.id || msg?.msgId);
    if (msg.messageId) {
        msg.id = msg.messageId;
    }
    msg.deliveryStatus = resolveOutgoingMessageStatus(msg) || msg.deliveryStatus || null;
    chats[msg.chatId].msgs.push(msg);

    // Atualizar preview da última mensagem
    chats[msg.chatId].lastMsg = {
        body: msg.body,
        fromMe: msg._isFromMe,
        timestamp: msg.timestamp,
        isMedia: msg.isMedia,
        mimetype: msg.mimetype || ""
    };

    if (msg._isFromMe) {
        void markChatOnboardingComplete();
    }

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

// Fallback acionado automaticamente (notificação para o operador)
socket.on("fallback_triggered", data => {
    if (!data || data.userId !== window.USER_ID) return;
    const { chatId, reason, matchedPhrase, triggeredAt } = data;

    const labels = {
        user_request: "Cliente pediu humano",
        repetition_limit: "Mensagens repetidas",
        frustration_limit: "Frustração detectada",
        ai_failure: "Falha da IA",
        ai_uncertainty: "IA sem confiança",
        ai_transfer: "IA sugeriu transferir",
        cooldown: "Em cooldown",
        silence_window: "Horário de silêncio",
    };

    const label = labels[reason] || "Fallback automático";
    appendInternalSystemNote({
        chatId,
        type: "fallback",
        title: "Fallback automático",
        message: `Fallback ativado (${label}).`,
        detail: matchedPhrase ? `Frase que disparou: "${matchedPhrase}".` : "",
        timestamp: triggeredAt || Date.now(),
    });
});

socket.on("system_note", data => {
    if (!data || data.userId !== window.USER_ID) return;
    appendInternalSystemNote(data);
});

socket.on("chat_ai_state", ({ chatId, state }) => {
    if (!chats[chatId]) return;
    chats[chatId].ai = state;
    if (currentChat === chatId) {
        updateAiUi(chatId);
        renderChatContext(chatId);
    }
    renderChatList();
});

socket.on("onboarding:step", ({ step }) => {
    if (Number(step) >= 4) {
        onboardingAlreadyCompleted = true;
        if (chatBootstrap?.user) {
            chatBootstrap.user.onboarding_step = 4;
        }
    }
});

socket.on("contact-tags:changed", payload => {
    handleContactTagsChanged(payload);
});

socket.on("crm:changed", () => {
    loadContactTags(true);
    if (currentChat) {
        loadChatContext(currentChat);
    }
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
    row.id = "typingBubble";
    row.dataset.typingIndicator = "true";

    row.innerHTML = `
        <div class="msg-bubble typing-bubble typing-indicator">
            <div class="typing-dots">
                <span></span><span></span><span></span>
            </div>
            <span class="typing-label">Bot processando...</span>
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
    document.querySelectorAll("#typingBubble, #typing-indicator, [data-typing-indicator='true']").forEach((el) => {
        el.remove();
    });
}

socket.on("typing:start", ({ chatId }) => {
    showTyping(chatId);
});

socket.on("typing:stop", ({ chatId }) => {
    if (currentChat === chatId) hideTyping();
});

socket.on("bot:typing", ({ chatId }) => {
    showTyping(chatId);
});

socket.on("bot:typed", ({ chatId }) => {
    if (currentChat === chatId) hideTyping();
});

socket.on("msg:status", ({ chatId, msgId, status }) => {
    if (!chatId || !msgId || !status) return;
    updateMessageStatusInMemory(chatId, msgId, status);
    updateMessageStatusInDom(chatId, msgId, status);
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
const emojiTabs = document.getElementById("emojiTabs");
const emojiScroll = document.getElementById("emojiScroll");
const emojiSearch = document.getElementById("emojiSearch");
const btnEmoji = document.querySelector(".btn-emoji");
const closeEmoji = document.getElementById("closeEmoji");

// Palavras-chave básicas para busca (pt/br + aliases simples)
const emojiKeywords = {
    "🔥": ["fogo", "fire"],
    "❤️": ["coração", "coracao", "amor", "love", "heart"],
    "💙": ["coração", "coracao", "azul", "amor"],
    "💚": ["coração", "coracao", "verde", "amor"],
    "💛": ["coração", "coracao", "amarelo", "amor"],
    "💜": ["coração", "coracao", "roxo", "amor"],
    "🖤": ["coração", "coracao", "preto"],
    "🤍": ["coração", "coracao", "branco"],
    "🤎": ["coração", "coracao", "marrom"],
    "👍": ["joinha", "ok", "like", "positivo", "beleza", "confirmar"],
    "👌": ["ok", "perfeito", "certo"],
    "🙏": ["oração", "rezar", "obrigado", "gratidão", "grato"],
    "😂": ["risada", "rindo", "kkk", "haha", "chorando"],
    "🤣": ["risada", "rindo", "rolando", "lol"],
    "😊": ["feliz", "sorriso", "smile"],
    "😉": ["piscar", "wink", "brincadeira"],
    "😭": ["choro", "chorando", "triste"],
    "😢": ["triste", "chorando"],
    "😡": ["bravo", "raiva", "irritado"],
    "🤬": ["xingar", "raiva"],
    "😍": ["apaixonado", "love", "amor"],
    "😘": ["beijo", "kiss"],
    "😎": ["cool", "óculos", "oculos", "style"],
    "🤯": ["mindblown", "explodiu", "chocado"],
    "😱": ["susto", "grito", "assustado"],
    "🤔": ["pensando", "thinking"],
    "🤫": ["silêncio", "silencio", "shh"],
    "👏": ["palmas", "aplauso"],
    "🙌": ["uhul", "celebrar", "palmas"],
    "💯": ["100", "perfeito", "top"],
    "🚀": ["foguete", "rocket", "decolar", "crescer"],
    "⭐": ["estrela", "star", "favorito"],
    "✅": ["check", "ok", "confirmado"],
    "❌": ["erro", "x", "cancelar"]
};

const emojiCategories = [
    {
        id: "smileys",
        label: "Rostos",
        icon: "😊",
        list: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 😎 🥳 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 🤬 😈 👿 💀 ☠️ 🤡 👽 🤖 💩".split(" ")
    },
    {
        id: "gestures",
        label: "Mãos",
        icon: "👍",
        list: "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 🖕 ✋ 🤚 🖐 🖖 👋 🤝 🙏 🤲 👐 ✊ 👊 🤛 🤜 👏 🙌 🫶 🤲🏻 🫶🏾 🫱 🫲 🫸 🫷 🫳 🫴 🤳 💪 🦾 🖍️".split(" ")
    },
    {
        id: "people",
        label: "Pessoas",
        icon: "🧑",
        list: "👶 👧 🧒 👦 👩 👨 🧑 👩‍🦱 👨‍🦱 👩‍🦳 👨‍🦳 👩‍🦰 👨‍🦰 👩‍🦲 👨‍🦲 🧔 🧕 👮 👷 🧑‍⚕️ 🧑‍🍳 🧑‍🎓 🧑‍🏫 🧑‍⚖️ 🧑‍🌾 🧑‍🔧 🧑‍🏭 🧑‍💻 🧑‍🎤 🧑‍🎨 🧑‍✈️ 🧑‍🚀 🧑‍🚒 🕵️ 🧙 🧛 🧜 🧚 🧞 🧝 🧟".split(" ")
    },
    {
        id: "animals",
        label: "Animais",
        icon: "🐶",
        list: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🐌 🦋 🐞 🐜 🦂 🦟 🦗 🕷 🐢 🐍 🦎 🦂 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🐊 🐆".split(" ")
    },
    {
        id: "food",
        label: "Comida",
        icon: "🍔",
        list: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🫒 🥑 🍆 🥔 🥕 🌽 🌶 🫑 🥒 🧄 🧅 🥬 🥦 🍄 🥜 🌰 🍞 🥐 🥖 🧀 🥚 🍳 🧇 🥞 🧈 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥙 🧆 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍚 🍙 🍘 🍥 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🧋 ☕ 🍺 🍻 🍷 🥂 🥃".split(" ")
    },
    {
        id: "objects",
        label: "Objetos",
        icon: "🎁",
        list: "⌚ 📱 💻 ⌨️ 🖱️ 🖥️ 🖨️ 🕹️ 💽 💾 📼 📷 🎥 📞 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ ⏱️ ⏲️ ⏰ 🧭 🔋 🔌 💡 🔦 🕯️ 🧯 🛢️ 🧨 🎆 🎇 🧸 🎈 🎁 🧿 🪔 🧧 🎀 🎗️ 🧵 🧶 🪡 🪢".split(" ")
    },
    {
        id: "symbols",
        label: "Símbolos",
        icon: "❤️",
        list: "❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ ✡️ ☸️ 🕉️ ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🔯 🕎 🔀 🔁 🔂 ▶️ ⏩ ⏭️ ⏯️ ⏮️ ⏪ ◀️ 🔼 🔽 ⏫ ⏬ ➡️ ⬅️ ⬆️ ⬇️ ↔️ ↕️ ⚠️ ⛔ 🚫 ❌ ✅ ✔️ ☑️ 🔘 ⚪ ⚫ 🔴 🟠 🟡 🟢 🔵 🟣 🟤 ⚫️".split(" ")
    },
    {
        id: "flags",
        label: "Bandeiras",
        icon: "🏳️",
        list: "🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🇧🇷 🇵🇹 🇪🇸 🇬🇧 🇫🇷 🇮🇹 🇩🇪 🇺🇸 🇨🇦 🇲🇽 🇦🇷 🇨🇱 🇨🇴 🇵🇪 🇺🇾 🇵🇾 🇧🇴 🇻🇪 🇯🇵 🇨🇳 🇰🇷 🇮🇳 🇦🇪 🇸🇦 🇹🇷 🇿🇦 🇳🇬 🇦🇺 🇳🇿".split(" ")
    }
];

function buildEmojiPicker(term = "") {
    if (!emojiTabs || !emojiScroll) return;

    const query = term.trim().toLowerCase();

    emojiTabs.innerHTML = "";
    emojiScroll.innerHTML = "";

    const sections = [];

    emojiCategories.forEach(cat => {
        const filtered = cat.list.filter(e => {
            if (!query) return true;
            if (e.toLowerCase().includes(query)) return true; // usuário digitou o próprio emoji
            const keywords = emojiKeywords[e] || [];
            const haystack = `${cat.label.toLowerCase()} ${keywords.join(" ").toLowerCase()}`;
            return haystack.includes(query);
        });
        if (!filtered.length) return;

        const btn = document.createElement("button");
        btn.className = "emoji-tab";
        btn.dataset.target = cat.id;
        btn.innerHTML = `${cat.icon}<span>${cat.label}</span>`;
        btn.onclick = () => {
            const sec = document.getElementById(`emoji-${cat.id}`);
            sec?.scrollIntoView({ behavior: "smooth", block: "start" });
        };
        emojiTabs.appendChild(btn);

        const section = document.createElement("section");
        section.id = `emoji-${cat.id}`;
        section.className = "emoji-section";
        section.innerHTML = `<div class="emoji-section-title">${cat.icon} ${cat.label}</div>`;

        const grid = document.createElement("div");
        grid.className = "emoji-section-grid";

        filtered.forEach(e => {
            const span = document.createElement("span");
            span.textContent = e;
            span.onclick = () => {
                inputMsg.value += e;
                inputMsg.focus();
            };
            grid.appendChild(span);
        });

        section.appendChild(grid);
        emojiScroll.appendChild(section);
        sections.push(section);
    });

    // fallback sem resultados
    if (!sections.length) {
        const empty = document.createElement("div");
        empty.className = "emoji-empty";
        empty.textContent = "Nada encontrado 😔";
        emojiScroll.appendChild(empty);
        return;
    }

    setActiveTab(sections[0].id.replace("emoji-", ""));
    observeSections();
}

function setActiveTab(id) {
    emojiTabs.querySelectorAll(".emoji-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.target === id);
    });
}

let emojiObserver = null;
function observeSections() {
    emojiObserver?.disconnect();
    const options = { root: emojiScroll, threshold: [0.2, 0.6] };
    emojiObserver = new IntersectionObserver((entries) => {
        const visible = entries
            .filter(e => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
            const id = visible[0].target.id.replace("emoji-", "");
            setActiveTab(id);
        }
    }, options);

    emojiScroll.querySelectorAll(".emoji-section").forEach(sec => emojiObserver.observe(sec));
}

btnEmoji.addEventListener("click", () => {
    buildEmojiPicker(emojiSearch?.value || "");
    emojiModal.style.display = "flex";
    emojiSearch?.focus();
});
closeEmoji.addEventListener("click", () => emojiModal.style.display = "none");
emojiModal.addEventListener("click", e => {
    if (e.target === emojiModal) emojiModal.style.display = "none";
});

emojiSearch?.addEventListener("input", (e) => {
    buildEmojiPicker(e.target.value);
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
