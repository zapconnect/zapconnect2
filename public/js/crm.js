// ======================================================
// CRM KANBAN — JS COMPLETO E CORRIGIDO
// ======================================================

let clients = [];
let selectedClient = null;
let sortBy = "name"; // "name" | "last_seen" | "follow_up" | "value"
let sortDir = "asc"; // "asc" | "desc"
let activeFilters = {
    text: "",
    stages: [],
    tags: [],
    minValue: 0,
    hasFollowUp: false,
};

let modalTags = [];
let modalNotes = [];
let viewMode = "kanban"; // "kanban" | "list"
let currentPage = 1;
let totalPages = 1;
let isLoading = false;
const PAGE_SIZE = 100;
const PHONE_BR_PREFIX = getConfiguredDefaultDdi();
const PHONE_BR_MIN_LENGTH = PHONE_BR_PREFIX.length + 10;
const PHONE_BR_MAX_LENGTH = PHONE_BR_PREFIX.length + 11;
const CRM_STAGE_ORDER = ["Novo", "Qualificando", "Negociação", "Fechado", "Perdido"];
const CRM_STAGE_SHORT_LABELS = {
    Novo: "Novo",
    Qualificando: "Qualif.",
    "Negociação": "Negociar",
    Fechado: "Fechar",
    Perdido: "Perdido",
};
let activeQuickPanel = { clientId: null, type: null };

// ------------------------------------------------------
// SOCKET.IO (atualização em tempo real)
// ------------------------------------------------------
let socket = null;
try {
    socket = io({ auth: { userId: window.USER_ID } });
    socket.on("crm:changed", () => {
        loadClients(true);
    });
} catch (err) {
    console.warn("Socket CRM indisponível:", err);
}

function notifyCrmChanged() {
    try { socket?.emit("crm:changed_local"); } catch { /* ignore */ }
}

function normalizeStage(stage) {
    const s = (stage || "Novo")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const map = {
        novo: "Novo",
        qualificando: "Qualificando",
        negociacao: "Negociação",
        negociacao: "Negociação",
        fechado: "Fechado",
        perdido: "Perdido",
    };
    return map[s] || "Novo";
}

// Toast (usa helper global quando disponível)
function showToast(msg, type = "success") {
    if (window.showToast) return window.showToast(type, msg);
    alert(msg);
}

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function stageToSlug(stage) {
    return String(stage || "Novo")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function getClientById(id) {
    return clients.find((client) => Number(client.id) === Number(id)) || null;
}

function isQuickPanelOpen(clientId, type) {
    return Number(activeQuickPanel.clientId) === Number(clientId)
        && activeQuickPanel.type === type;
}

function setActiveQuickPanel(clientId = null, type = null) {
    const samePanel = Number(activeQuickPanel.clientId) === Number(clientId)
        && activeQuickPanel.type === type;

    activeQuickPanel = samePanel || !clientId
        ? { clientId: null, type: null }
        : { clientId: Number(clientId), type };

    renderBoard();
}

function closeQuickPanel() {
    if (!activeQuickPanel.clientId) return;
    activeQuickPanel = { clientId: null, type: null };
    renderBoard();
}

function getQuickStageOptions(currentStage) {
    const stage = normalizeStage(currentStage);

    if (stage === "Novo") return ["Qualificando", "Negociação", "Fechado", "Perdido"];
    if (stage === "Qualificando") return ["Negociação", "Novo", "Fechado", "Perdido"];
    if (stage === "Negociação") return ["Fechado", "Perdido", "Qualificando", "Novo"];
    if (stage === "Fechado") return ["Negociação", "Qualificando", "Novo", "Perdido"];
    if (stage === "Perdido") return ["Negociação", "Qualificando", "Novo", "Fechado"];

    return CRM_STAGE_ORDER.filter((item) => item !== stage);
}

function getQuickFollowUpTimestamp(mode) {
    if (mode === "clear") return null;

    const date = new Date();
    date.setHours(0, 0, 0, 0);

    if (mode === "tomorrow") {
        date.setDate(date.getDate() + 1);
    } else if (mode === "next7") {
        date.setDate(date.getDate() + 7);
    }

    return date.getTime();
}

function buildClientUpdateBody(client, patch = {}) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    const rawDealValue = hasOwn("deal_value") ? patch.deal_value : client?.deal_value;
    const normalizedDealValue = rawDealValue == null || rawDealValue === ""
        ? null
        : (Number(rawDealValue) || 0);

    return {
        id: Number(client?.id || 0),
        name: String(hasOwn("name") ? patch.name : client?.name || "").trim(),
        phone: String(hasOwn("phone") ? patch.phone : client?.phone || "").replace(/\D/g, ""),
        citystate: String(hasOwn("citystate") ? patch.citystate : client?.citystate || "").trim(),
        stage: normalizeStage(hasOwn("stage") ? patch.stage : client?.stage),
        tags: JSON.stringify(hasOwn("tags") ? parseJsonArray(patch.tags) : parseJsonArray(client?.tags)),
        notes: JSON.stringify(hasOwn("notes") ? parseJsonArray(patch.notes) : parseJsonArray(client?.notes)),
        deal_value: normalizedDealValue,
        follow_up_date: hasOwn("follow_up_date")
            ? patch.follow_up_date
            : (client?.follow_up_date ? Number(client.follow_up_date) : null),
    };
}

function patchClientInMemory(id, patch = {}) {
    const targetId = Number(id);
    const index = clients.findIndex((client) => Number(client.id) === targetId);
    if (index === -1) return;

    clients[index] = { ...clients[index], ...patch };

    if (selectedClient && Number(selectedClient.id) === targetId) {
        selectedClient = { ...selectedClient, ...patch };
    }
}

function openClientEditor(id, { focusFollowUp = false } = {}) {
    closeQuickPanel();
    selectClient(id);
    openClientModal();

    if (focusFollowUp && modalFollowUp) {
        setTimeout(() => {
            modalFollowUp.scrollIntoView({ behavior: "smooth", block: "center" });
            modalFollowUp.focus();
            try { modalFollowUp.showPicker?.(); } catch { /* ignore */ }
        }, 160);
    }
}

async function quickMoveClientStage(id, stage) {
    const client = getClientById(id);
    if (!client) return;

    const nextStage = normalizeStage(stage);
    if (normalizeStage(client.stage) === nextStage) {
        closeQuickPanel();
        return;
    }

    try {
        const res = await fetch("/api/crm/stage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, stage: nextStage }),
        });
        const data = await res.json();

        if (!res.ok || data.ok === false) {
            throw new Error(data.error || "Erro ao atualizar estágio");
        }

        patchClientInMemory(id, { stage: nextStage });
        activeQuickPanel = { clientId: null, type: null };
        renderBoard();
        notifyCrmChanged();
        showToast(`Cliente movido para ${nextStage}.`);
    } catch (err) {
        console.error(err);
        showToast(err?.message || "Erro ao atualizar estágio", "error");
    }
}

async function quickSetFollowUp(id, mode) {
    const client = getClientById(id);
    if (!client) return;

    const followUpDate = getQuickFollowUpTimestamp(mode);
    const labels = {
        today: "Follow-up agendado para hoje.",
        tomorrow: "Follow-up agendado para amanhã.",
        next7: "Follow-up agendado para daqui 7 dias.",
        clear: "Follow-up removido.",
    };

    try {
        const body = buildClientUpdateBody(client, { follow_up_date: followUpDate });
        const res = await fetch("/api/crm/update", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();

        if (!res.ok || data.ok === false) {
            throw new Error(data.error || "Erro ao atualizar follow-up");
        }

        patchClientInMemory(id, { follow_up_date: followUpDate });
        activeQuickPanel = { clientId: null, type: null };
        renderBoard();
        showToast(labels[mode] || "Follow-up atualizado.");
    } catch (err) {
        console.error(err);
        showToast(err?.message || "Erro ao atualizar follow-up", "error");
    }
}

function getConfiguredDefaultDdi() {
    const digits = String(document.body?.dataset?.defaultDdi || "55")
        .replace(/\D/g, "")
        .slice(0, 4);

    return digits || "55";
}

function bindCurrencyMask(ids) {
    ids.forEach((id) => {
        const input = document.getElementById(id);
        if (!input || input.dataset.currencyMaskBound === "1") return;

        input.dataset.currencyMaskBound = "1";
        input.addEventListener("input", () => applyCurrencyMask(input));
        input.addEventListener("blur", () => applyCurrencyMask(input));
    });
}

function applyCurrencyMask(input) {
    const digits = String(input?.value || "").replace(/\D/g, "");
    input.value = digits ? formatCurrencyMaskDigits(digits) : "";
}

function formatCurrencyMaskDigits(digits) {
    const numericValue = Number(digits) / 100;
    return numericValue.toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function parseCurrencyInput(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/\s+/g, "")
        .replace(/[R$]/g, "")
        .replace(/\./g, "")
        .replace(",", ".")
        .replace(/[^\d.-]/g, "");

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function bindPhoneMask(ids) {
    ids.forEach((id) => {
        const input = document.getElementById(id);
        if (!input || input.dataset.phoneMaskBound === "1") return;

        input.dataset.phoneMaskBound = "1";
        input.addEventListener("focus", () => {
            if (!String(input.value || "").trim()) {
                input.value = PHONE_BR_PREFIX;
            }
            applyPhoneMask(input);
        });
        input.addEventListener("input", () => applyPhoneMask(input));
        input.addEventListener("blur", () => applyPhoneMask(input));
        applyPhoneMask(input);
    });
}

function setPhoneInputValue(inputOrId, value = "") {
    const input =
        typeof inputOrId === "string"
            ? document.getElementById(inputOrId)
            : inputOrId;

    if (!input) return;
    input.value = value;
    applyPhoneMask(input);
}

function applyPhoneMask(input) {
    const digits = normalizeBrazilPhoneDigits(input?.value);
    input.value = formatBrazilPhone(digits);
}

function normalizeBrazilPhoneDigits(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return PHONE_BR_PREFIX;
    if (PHONE_BR_PREFIX.startsWith(digits) && digits.length <= PHONE_BR_PREFIX.length) {
        return PHONE_BR_PREFIX;
    }

    const raw = digits.startsWith(PHONE_BR_PREFIX) ? digits : `${PHONE_BR_PREFIX}${digits}`;
    return raw.slice(0, PHONE_BR_MAX_LENGTH);
}

function formatBrazilPhone(digits) {
    const normalized = normalizeBrazilPhoneDigits(digits);
    const ddiLength = PHONE_BR_PREFIX.length;
    const countryCode = normalized.slice(0, ddiLength);
    const ddd = normalized.slice(ddiLength, ddiLength + 2);
    const phone = normalized.slice(ddiLength + 2);

    let formatted = countryCode;
    if (ddd) {
        formatted += ` (${ddd}`;
        if (ddd.length === 2) formatted += ")";
    }
    if (phone) {
        formatted += ` ${formatBrazilPhoneLocal(phone)}`;
    }
    return formatted;
}

function formatBrazilPhoneLocal(phone) {
    if (phone.length <= 4) return phone;
    if (phone.length <= 8) {
        return `${phone.slice(0, 4)}-${phone.slice(4)}`;
    }
    return `${phone.slice(0, 5)}-${phone.slice(5, 9)}`;
}

function isValidBrazilPhone(value) {
    const digits = normalizeBrazilPhoneDigits(value);
    return digits.startsWith(PHONE_BR_PREFIX) && digits.length >= PHONE_BR_MIN_LENGTH;
}

function formatPhoneDisplay(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return "—";
    if (digits.length > PHONE_BR_MAX_LENGTH && !digits.startsWith(PHONE_BR_PREFIX)) {
        return digits;
    }
    return formatBrazilPhone(digits);
}

function getPhoneDigits(value) {
    return normalizeBrazilPhoneDigits(value);
}

// ------------------------------------------------------
// ELEMENTOS
// ------------------------------------------------------
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("crmSearch");
const stagePillsWrap = document.getElementById("stagePills");
const tagPillsWrap = document.getElementById("tagPills");
const minValueInput = document.getElementById("minValueInput");
const followUpCheck = document.getElementById("followUpCheck");
const crmResultCount = document.getElementById("crmResultCount");

// Filtros
const filterNovo = document.getElementById("filterNovo");
const filterQualificando = document.getElementById("filterQualificando");
const filterNegociacao = document.getElementById("filterNegociacao");
const filterFechado = document.getElementById("filterFechado");
const filterPerdido = document.getElementById("filterPerdido");
const filtersWrap = document.getElementById("filters");
const filtersToggle = document.getElementById("filtersToggle");
const filtersPanel = document.getElementById("filtersPanel");
let filtersManual = false; // usuário já interagiu

function setFiltersOpen(isOpen) {
    if (!filtersWrap) return;
    filtersWrap.classList.toggle("is-collapsed", !isOpen);
    filtersToggle?.setAttribute("aria-expanded", String(isOpen));
    if (filtersPanel) filtersPanel.hidden = !isOpen;
}

filtersToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    filtersManual = true;
    const willOpen = filtersWrap?.classList.contains("is-collapsed");
    setFiltersOpen(Boolean(willOpen));
});

document.addEventListener("click", (e) => {
    if (!filtersWrap || filtersWrap.classList.contains("is-collapsed")) return;
    if (!filtersWrap.contains(e.target)) setFiltersOpen(false);
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setFiltersOpen(false);
});

function autoFiltersByWidth() {
    if (filtersManual) return;
    const isSmall = window.innerWidth <= 700;
    setFiltersOpen(!isSmall);
}

setFiltersOpen(true);
window.addEventListener("resize", autoFiltersByWidth);
window.addEventListener("load", autoFiltersByWidth);

// Modal inputs
const modalName = document.getElementById("modalName");
const modalPhone = document.getElementById("modalPhone");
const modalCity = document.getElementById("modalCity");
const modalStage = document.getElementById("modalStage");

const modalTagsWrap = document.getElementById("modalTags");
const modalNotesWrap = document.getElementById("modalNotes");

const modalNewTag = document.getElementById("modalNewTag");
const modalAddTag = document.getElementById("modalAddTag");

const modalNoteText = document.getElementById("modalNoteText");
const modalAddNote = document.getElementById("modalAddNote");

const modalSave   = document.getElementById("modalSave");
const modalValue    = document.getElementById("modalValue");
const modalFollowUp = document.getElementById("modalFollowUp");
const modalDelete = document.getElementById("modalDelete");
const modalCancel = document.getElementById("modalCancel");
const clientModal = document.getElementById("clientModal");
const closeModalBtn = document.getElementById("closeClientModal");

bindPhoneMask(["modalPhone"]);
bindCurrencyMask(["modalValue"]);

closeModalBtn?.addEventListener("click", closeClientModal);

// View toggle
const btnViewKanban = document.getElementById("btnViewKanban");
const btnViewList = document.getElementById("btnViewList");
const listView = document.getElementById("listView");
const kanbanBoard = document.getElementById("kanbanBoard");

function setViewMode(mode) {
    viewMode = mode;
    document.body.classList.toggle("list-mode", mode === "list");
    if (btnViewKanban) btnViewKanban.classList.toggle("active", mode === "kanban");
    if (btnViewList) btnViewList.classList.toggle("active", mode === "list");
    renderBoard(); // re-render to fill list/kanban
}

btnViewKanban?.addEventListener("click", () => setViewMode("kanban"));
btnViewList?.addEventListener("click", () => setViewMode("list"));

// define modo padrão em telas pequenas
function autoViewByWidth() {
    if (window.innerWidth <= 700) setViewMode("list");
    else setViewMode(viewMode === "list" ? "kanban" : viewMode); // mantém escolha
}
window.addEventListener("resize", autoViewByWidth);
window.addEventListener("load", autoViewByWidth);

// ------------------------------------------------------
// RENDER TAGS DO MODAL
// ------------------------------------------------------
function renderModalTags() {
    modalTagsWrap.innerHTML = "";

    modalTags.forEach((tag, index) => {
        const p = tagPalette(tag);
        const div = document.createElement("div");
        div.className = "tag";
        div.style.background = p.bg;
        div.style.color = p.color;
        div.style.border = `1px solid ${p.border}`;
        div.innerHTML = `${escapeHtml(tag)} <span class="remove-tag" data-i="${index}" style="opacity:.6;cursor:pointer;">✕</span>`;
        modalTagsWrap.appendChild(div);
    });

    modalTagsWrap.querySelectorAll(".remove-tag").forEach(el => {
        el.onclick = () => {
            modalTags.splice(el.dataset.i, 1);
            renderModalTags();
        };
    });
}

// ------------------------------------------------------
// RENDER NOTAS DO MODAL
// ------------------------------------------------------
function renderModalNotes() {
    modalNotesWrap.innerHTML = "";

    if (!modalNotes.length) {
        modalNotesWrap.innerHTML = `<div class="note empty">Nenhuma nota ainda</div>`;
        return;
    }

    modalNotes.forEach(n => {
        const div = document.createElement("div");
        div.className = "note";
        div.innerHTML =
            `<b>${escapeHtml(new Date(n.created_at).toLocaleString())}</b><br>${escapeHtml(n.text)}`;
        modalNotesWrap.appendChild(div);
    });
}

function mergeClientsPage(incomingClients, replace = false) {
    const nextClients = replace ? [] : [...clients];
    const indexById = new Map(
        nextClients.map((client, index) => [String(client.id), index])
    );

    incomingClients.forEach((client) => {
        const key = String(client.id);
        const existingIndex = indexById.get(key);

        if (existingIndex == null) {
            indexById.set(key, nextClients.length);
            nextClients.push(client);
            return;
        }

        nextClients[existingIndex] = client;
    });

    clients = nextClients;
}

function getClientTags(client) {
    return Array.isArray(client?.tags) ? client.tags : parseJsonArray(client?.tags);
}

function hasClientFollowUp(client) {
    return Boolean(client?.follow_up_date || client?.follow_up_at);
}

function getUniqueClientTags() {
    return Array.from(
        new Set(
            clients.flatMap((client) =>
                getClientTags(client)
                    .map((tag) => String(tag || "").trim())
                    .filter(Boolean)
            )
        )
    ).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function syncFilterInputs() {
    if (searchInput) searchInput.value = activeFilters.text;
    if (minValueInput) {
        minValueInput.value = activeFilters.minValue ? String(activeFilters.minValue) : "";
    }
    if (followUpCheck) followUpCheck.checked = Boolean(activeFilters.hasFollowUp);
}

function sanitizeActiveFilters() {
    activeFilters.text = String(activeFilters.text || "").trim().toLowerCase();
    activeFilters.stages = activeFilters.stages
        .map((stage) => normalizeStage(stage))
        .filter((stage, index, list) => CRM_STAGE_ORDER.includes(stage) && list.indexOf(stage) === index);

    const availableTags = new Set(getUniqueClientTags());
    activeFilters.tags = activeFilters.tags
        .map((tag) => String(tag || "").trim())
        .filter((tag, index, list) => tag && availableTags.has(tag) && list.indexOf(tag) === index);

    activeFilters.minValue = Math.max(0, Number(activeFilters.minValue) || 0);
    activeFilters.hasFollowUp = Boolean(activeFilters.hasFollowUp);
}

function applyFilters() {
    sanitizeActiveFilters();

    return clients.filter((client) => {
        const normalizedStage = normalizeStage(client.stage);
        const tags = getClientTags(client);
        const phone = String(client.phone || "").replace(/\D/g, "");
        const textHaystack = [
            client.name || "",
            phone,
            client.citystate || "",
        ]
            .join(" ")
            .toLowerCase();

        const textMatch = !activeFilters.text || textHaystack.includes(activeFilters.text);
        const stageMatch =
            activeFilters.stages.length === 0 || activeFilters.stages.includes(normalizedStage);
        const tagMatch =
            activeFilters.tags.length === 0
                || activeFilters.tags.some((tag) => tags.includes(tag));
        const valueMatch =
            !activeFilters.minValue || (Number(client.deal_value || 0) >= activeFilters.minValue);
        const followUpMatch = !activeFilters.hasFollowUp || hasClientFollowUp(client);

        return textMatch && stageMatch && tagMatch && valueMatch && followUpMatch;
    });
}

function getSortedClients(items) {
    return [...items].sort((a, b) => {
        let va;
        let vb;

        if (sortBy === "name") {
            va = (a.name || "").toLowerCase();
            vb = (b.name || "").toLowerCase();
        } else if (sortBy === "last_seen") {
            va = Number(a.last_seen) || 0;
            vb = Number(b.last_seen) || 0;
        } else if (sortBy === "follow_up") {
            va = Number(a.follow_up_date) || Infinity;
            vb = Number(b.follow_up_date) || Infinity;
        } else if (sortBy === "value") {
            va = Number(a.deal_value) || 0;
            vb = Number(b.deal_value) || 0;
        }

        if (va < vb) return sortDir === "asc" ? -1 : 1;
        if (va > vb) return sortDir === "asc" ? 1 : -1;
        return 0;
    });
}

function updateResultCount(count) {
    if (!crmResultCount) return;

    const totalLabel = count === 1 ? "cliente" : "clientes";
    const extras = [];

    if (activeFilters.minValue > 0) {
        extras.push(`R$ ${activeFilters.minValue.toLocaleString("pt-BR")}+`);
    }
    if (activeFilters.hasFollowUp) {
        extras.push("com follow-up");
    }

    crmResultCount.textContent = `${count} ${totalLabel}${extras.length ? ` • ${extras.join(" • ")}` : ""}`;
}

function renderFilterPills() {
    sanitizeActiveFilters();

    if (stagePillsWrap) {
        stagePillsWrap.innerHTML = CRM_STAGE_ORDER.map((stage) => {
            const isActive = activeFilters.stages.includes(stage);
            return `
              <button
                type="button"
                class="filter-pill${isActive ? " active" : ""}"
                data-filter-type="stage"
                data-filter-value="${escapeHtml(stage)}"
              >
                ${escapeHtml(stage)}${isActive ? " ✕" : ""}
              </button>
            `;
        }).join("");

        stagePillsWrap.querySelectorAll("[data-filter-type='stage']").forEach((button) => {
            button.addEventListener("click", () => {
                toggleFilterValue("stages", button.dataset.filterValue || "");
            });
        });
    }

    if (tagPillsWrap) {
        const availableTags = getUniqueClientTags();

        if (!availableTags.length) {
            tagPillsWrap.innerHTML = `<span class="filter-pill empty">Sem tags carregadas</span>`;
        } else {
            tagPillsWrap.innerHTML = availableTags.map((tag) => {
                const isActive = activeFilters.tags.includes(tag);
                return `
                  <button
                    type="button"
                    class="filter-pill${isActive ? " active" : ""}"
                    data-filter-type="tag"
                    data-filter-value="${escapeHtml(tag)}"
                  >
                    ${escapeHtml(tag)}${isActive ? " ✕" : ""}
                  </button>
                `;
            }).join("");

            tagPillsWrap.querySelectorAll("[data-filter-type='tag']").forEach((button) => {
                button.addEventListener("click", () => {
                    toggleFilterValue("tags", button.dataset.filterValue || "");
                });
            });
        }
    }

    syncFilterInputs();
}

function toggleFilterValue(key, value) {
    const normalizedValue = key === "stages" ? normalizeStage(value) : String(value || "").trim();
    if (!normalizedValue) return;

    const currentValues = Array.isArray(activeFilters[key]) ? [...activeFilters[key]] : [];
    const nextValues = currentValues.includes(normalizedValue)
        ? currentValues.filter((item) => item !== normalizedValue)
        : [...currentValues, normalizedValue];

    activeFilters = { ...activeFilters, [key]: nextValues };
    renderFilterPills();
    renderBoard();
}

function updateFilter(key, value) {
    if (key === "text") {
        activeFilters = { ...activeFilters, text: String(value || "").trim().toLowerCase() };
    } else if (key === "minValue") {
        activeFilters = { ...activeFilters, minValue: Math.max(0, Number(value) || 0) };
    } else if (key === "hasFollowUp") {
        activeFilters = { ...activeFilters, hasFollowUp: Boolean(value) };
    } else {
        activeFilters = { ...activeFilters, [key]: value };
    }

    renderFilterPills();
    renderBoard();
}

function clearAllFilters() {
    activeFilters = {
        text: "",
        stages: [],
        tags: [],
        minValue: 0,
        hasFollowUp: false,
    };

    renderFilterPills();
    renderBoard();
}

// ------------------------------------------------------
// LOAD CLIENTS
// ------------------------------------------------------
async function loadClients(reset = false) {
  if (isLoading) return;
  if (reset) {
    currentPage = 1;
    totalPages = 1;
    clients = [];
    renderFilterPills();
    renderBoard();
  }

  if (currentPage > totalPages) return;

  isLoading = true;
  try {
    const qs = new URLSearchParams({
      page: String(currentPage),
      pageSize: String(PAGE_SIZE),
    });

    const res = await fetch(`/api/crm/list?${qs.toString()}`);
    const data = await res.json();
    const incomingClients = Array.isArray(data.clients) ? data.clients : [];

    mergeClientsPage(incomingClients, reset || currentPage === 1);
    currentPage = data.page || currentPage;
    totalPages = data.totalPages || 1;

    toggleLoadMore();
    renderFilterPills();
    renderBoard();
  } catch (err) {
    console.error(err);
    showToast("Erro ao carregar clientes", "error");
  } finally {
    isLoading = false;
  }
}

function loadMoreClients() {
  if (currentPage >= totalPages) return;
  currentPage += 1;
  loadClients();
}

function toggleLoadMore() {
  const btn = document.getElementById("crmLoadMore");
  if (!btn) return;
  btn.style.display = currentPage < totalPages ? "inline-flex" : "none";
}

// ------------------------------------------------------
// COR DINÂMICA POR TAG (hash do texto)
// ------------------------------------------------------
const TAG_PALETTES = [
    { bg: "rgba(108,100,239,0.15)", border: "rgba(108,100,239,0.35)", color: "#a89ef5" }, // roxo
    { bg: "rgba(46,230,166,0.12)",  border: "rgba(46,230,166,0.3)",   color: "#2ee6a6" }, // verde
    { bg: "rgba(242,201,76,0.12)",  border: "rgba(242,201,76,0.3)",   color: "#f2c94c" }, // amarelo
    { bg: "rgba(90,200,250,0.12)",  border: "rgba(90,200,250,0.3)",   color: "#5ac8fa" }, // azul
    { bg: "rgba(255,95,95,0.12)",   border: "rgba(255,95,95,0.3)",    color: "#ff7070" }, // vermelho
    { bg: "rgba(242,153,74,0.12)",  border: "rgba(242,153,74,0.3)",   color: "#f2994a" }, // laranja
    { bg: "rgba(200,100,240,0.12)", border: "rgba(200,100,240,0.3)",  color: "#d066f0" }, // rosa
];

function tagPalette(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
    return TAG_PALETTES[Math.abs(hash) % TAG_PALETTES.length];
}

function renderTag(t, isClickable, isActive) {
    const p = tagPalette(t);
    const activeBg     = isActive ? p.color       : p.bg;
    const activeColor  = isActive ? "#0d1222"     : p.color;
    const activeBorder = isActive ? p.color       : p.border;
    const extraClass   = isClickable ? " tag-clickable" : "";
    const activeClass  = isActive ? " tag-active" : "";
    const safeTag = escapeHtml(t);
    return `<span
        class="tag${extraClass}${activeClass}"
        data-tag="${safeTag}"
        style="background:${activeBg};color:${activeColor};border:1px solid ${activeBorder};"
    >${safeTag}</span>`;
}

function renderQuickActionPanel(client, stage, followUpLabel) {
    const clientId = Number(client?.id || 0);

    if (isQuickPanelOpen(clientId, "move")) {
        const options = getQuickStageOptions(stage)
            .map((option) => `
              <button
                type="button"
                class="card-quick-chip"
                data-quick-stage="${escapeHtml(option)}"
              >${escapeHtml(CRM_STAGE_SHORT_LABELS[option] || option)}</button>
            `)
            .join("");

        return `
          <div class="card-quick-panel">
            <div class="card-quick-panel-meta">Mover sem arrastar:</div>
            ${options}
          </div>
        `;
    }

    if (isQuickPanelOpen(clientId, "followup")) {
        return `
          <div class="card-quick-panel">
            <div class="card-quick-panel-meta">
              ${followUpLabel ? `Retorno atual: ${escapeHtml(followUpLabel)}` : "Nenhum follow-up agendado."}
            </div>
            <button type="button" class="card-quick-chip" data-quick-followup="today">Hoje</button>
            <button type="button" class="card-quick-chip" data-quick-followup="tomorrow">Amanhã</button>
            <button type="button" class="card-quick-chip" data-quick-followup="next7">+7 dias</button>
            ${followUpLabel ? `<button type="button" class="card-quick-chip danger" data-quick-followup="clear">Limpar</button>` : ""}
          </div>
        `;
    }

    return "";
}

// ------------------------------------------------------
// RENDER KANBAN
// ------------------------------------------------------
function renderBoard() {
    const stages = {
        "Novo": document.querySelector('.kanban-dropzone[data-stage="Novo"]'),
        "Qualificando": document.querySelector('.kanban-dropzone[data-stage="Qualificando"]'),
        "Negociação": document.querySelector('.kanban-dropzone[data-stage="Negociação"]'),
        "Fechado": document.querySelector('.kanban-dropzone[data-stage="Fechado"]'),
        "Perdido": document.querySelector('.kanban-dropzone[data-stage="Perdido"]')
    };

    Object.values(stages).forEach(z => z.innerHTML = "");
    if (listView) listView.innerHTML = "";

    const counts = { Novo: 0, Qualificando: 0, "Negociação": 0, Fechado: 0, Perdido: 0 };
    const values = { Novo: 0, Qualificando: 0, "Negociação": 0, Fechado: 0, Perdido: 0 };
    let rendered = 0;

    const sorted = getSortedClients(getFilteredClients());
    updateResultCount(sorted.length);

    sorted.forEach(c => {
        const stage = normalizeStage(c.stage);
        const tags = getClientTags(c);

        const chatPhone = (c.phone || "").replace(/\D/g, "");
        const zoneName = stage;
        const zone = stages[zoneName];
        counts[zoneName]++;
        values[zoneName] = (values[zoneName] || 0) + (Number(c.deal_value) || 0);
        rendered++;

        // render list view card
        if (listView) {
            const item = document.createElement("div");
            item.className = "list-card";
            item.dataset.id = c.id;
            const tagsHtml = tags.map(t => renderTag(t, false, false)).join(" ");
            const stageColor = {
                "Novo": "var(--p-novo)",
                "Qualificando": "var(--p-qualificando)",
                "Negociação": "var(--p-negociacao)",
                "Perdido": "var(--p-perdido)",
                "Fechado": "var(--p-fechado)"
            }[zoneName] || "var(--accent)";

            const valueStr = Number(c.deal_value) > 0
                ? "R$ " + Number(c.deal_value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "";
            const fup = c.follow_up_date ? Number(c.follow_up_date) : null;
            const fupLabel = fup ? new Date(fup).toLocaleDateString("pt-BR") : "";
            const safeName = escapeHtml(c.name || "Sem nome");
            const safePhone = escapeHtml(formatPhoneDisplay(c.phone || ""));
            const safeCityState = escapeHtml(c.citystate || "Cidade não informada");
            const safeZoneName = escapeHtml(zoneName);
            const safeFupLabel = escapeHtml(fupLabel);
            const safeChatPhone = encodeURIComponent(chatPhone);

            item.innerHTML = `
              <h3>${safeName}</h3>
              <div class="list-cta">
                <a href="/chat?contact=${safeChatPhone}" target="_blank">Abrir chat</a>
                <button data-id="${c.id}" class="btn-list-edit">Editar</button>
              </div>
              <div class="list-meta">
                ${safePhone} • ${safeCityState}
              </div>
              <div class="list-meta">
                ${valueStr ? `<span>${escapeHtml(valueStr)}</span>` : ""}
                ${fupLabel ? `<span>Follow-up: ${safeFupLabel}</span>` : ""}
                ${c.stage ? `<span class="list-stage" style="background:${stageColor}20;color:${stageColor};border:1px solid ${stageColor}40;">${safeZoneName}</span>` : ""}
              </div>
              <div class="list-tags">${tagsHtml || ""}</div>
            `;
            listView.appendChild(item);
          }

        const card = document.createElement("div");
        card.className = "kanban-card";
        card.draggable = true;
        card.dataset.id = c.id;

        // Follow-up
        const now = Date.now();
        const fup = c.follow_up_date ? Number(c.follow_up_date) : null;
        const fupOverdue  = fup && fup < now;
        const fupToday    = fup && !fupOverdue && new Date(fup).toDateString() === new Date().toDateString();
        const fupLabel    = fup ? new Date(fup).toLocaleDateString("pt-BR") : null;

        if (fupOverdue)  card.classList.add("card-overdue");
        if (fupToday)    card.classList.add("card-today");

        // Avatar com iniciais
        const initials = (c.name || "?").trim().split(" ")
            .slice(0, 2).map(w => w[0].toUpperCase()).join("");
        const safeInitials = escapeHtml(initials);
        const safeName = escapeHtml(c.name || "Sem nome");
        const safePhone = escapeHtml(formatPhoneDisplay(c.phone || ""));
        const safeCityState = escapeHtml(c.citystate || "");
        const safeChatPhone = encodeURIComponent(chatPhone);
        const safeAvatar = escapeHtml(c.avatar || "");
        const safeStageLabel = escapeHtml(zoneName);
        const stageSlug = stageToSlug(zoneName);
        const quickPanelOpen = Number(activeQuickPanel.clientId) === Number(c.id);

        // Valor formatado
        const valueStr = Number(c.deal_value) > 0
            ? "R$ " + Number(c.deal_value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "";
        const safeValueStr = escapeHtml(valueStr);
        const safeFupLabel = escapeHtml(fupLabel || "");

        card.innerHTML = `
          <div class="card-inner">

            <!-- Topo: avatar + nome + valor -->
          <div class="card-top">
            <div class="card-avatar">${c.avatar
                ? `<img src="${safeAvatar}" alt="${safeInitials}" loading="lazy" />`
                : `<span>${safeInitials}</span>`}
            </div>
              <div class="card-info">
                <div class="card-name-row">
                  <div class="card-name">${safeName}</div>
                  <span class="card-stage-badge card-stage-${stageSlug}">${safeStageLabel}</span>
                </div>
                <div class="card-phone" title="${safePhone}">
                  <i class="fa-solid fa-phone"></i>
                  <span class="card-phone-text">${safePhone}</span>
                </div>
              </div>
              ${valueStr ? `<div class="card-value">${safeValueStr}</div>` : ""}
            </div>

            <!-- Localização -->
            ${c.citystate ? `
            <div class="card-location">
              <i class="fa-solid fa-location-dot"></i>
              ${safeCityState}
            </div>` : ""}

            <!-- Tags -->
            ${tags.length > 0 ? `
            <div class="card-tags">
              ${tags.slice(0, 3).map(t => renderTag(t, true, activeFilters.tags.includes(t))).join("")}
              ${tags.length > 3 ? `<span class="tag more">+${tags.length - 3}</span>` : ""}
            </div>` : ""}

            <!-- Follow-up -->
            ${fupLabel ? `
            <div class="card-followup ${fupOverdue ? "overdue" : fupToday ? "today" : ""}">
              <i class="fa-solid fa-clock"></i>
              ${fupOverdue ? "Vencido: " : fupToday ? "Hoje: " : "Retorno: "}${safeFupLabel}
            </div>` : ""}

            <!-- Footer: botão chat -->
            <div class="card-footer">
              <div class="card-quick-actions">
                <a
                  href="/chat?contact=${safeChatPhone}"
                  class="card-quick-btn quick-chat"
                  title="Abrir chat"
                  data-quick-action="chat"
                  onclick="event.stopPropagation()"
                >
                  <i class="fa-brands fa-whatsapp"></i>
                  <span>Chat</span>
                </a>
                <button type="button" class="card-quick-btn quick-followup" data-quick-action="followup">
                  <i class="fa-regular fa-calendar-check"></i>
                  <span>Follow-up</span>
                </button>
                <button type="button" class="card-quick-btn quick-move" data-quick-action="move">
                  <i class="fa-solid fa-arrow-right-arrow-left"></i>
                  <span>Mover</span>
                </button>
                <button type="button" class="card-quick-btn quick-edit" data-quick-action="edit" aria-label="Editar cliente">
                  <i class="fa-solid fa-plus"></i>
                </button>
              </div>
              ${renderQuickActionPanel(c, zoneName, fupLabel)}
            </div>

          </div>
        `;

        card.classList.toggle("quick-open", quickPanelOpen);

        card.addEventListener("click", (e) => {
            const quickActionEl = e.target.closest("[data-quick-action], [data-quick-stage], [data-quick-followup]");
            if (quickActionEl) {
                const isChatLink = quickActionEl.matches("a[data-quick-action='chat']");
                e.stopPropagation();
                if (!isChatLink) e.preventDefault();

                const quickAction = quickActionEl.dataset.quickAction;
                const quickStage = quickActionEl.dataset.quickStage;
                const quickFollowUp = quickActionEl.dataset.quickFollowup;

                if (quickStage) {
                    void quickMoveClientStage(c.id, quickStage);
                    return;
                }

                if (quickFollowUp) {
                    void quickSetFollowUp(c.id, quickFollowUp);
                    return;
                }

                if (quickAction === "edit") {
                    openClientEditor(c.id);
                    return;
                }

                if (quickAction === "followup") {
                    setActiveQuickPanel(c.id, "followup");
                    return;
                }

                if (quickAction === "move") {
                    setActiveQuickPanel(c.id, "move");
                    return;
                }

                if (quickAction === "chat") {
                    activeQuickPanel = { clientId: null, type: null };
                    return;
                }
            }

            // Se clicou em uma tag, filtrar por ela
            const tagEl = e.target.closest(".tag-clickable");
            if (tagEl) {
                e.stopPropagation();
                const tag = tagEl.dataset.tag;
                setActiveTag(tag);
                return;
            }
            selectClient(c.id);
            closeQuickPanel();
            openClientModal();
        });

        // drag events
        card.addEventListener("dragstart", onCardDragStart);
        card.addEventListener("dragend", onCardDragEnd);

        zone.appendChild(card);
    });

    // contadores e valores por coluna
    for (const k in counts) {
        const el = document.getElementById("count-" + k);
        if (el) el.innerText = counts[k];

        const valEl = document.getElementById("value-" + k);
        if (valEl) {
            const total = values[k] || 0;
            valEl.textContent = total > 0
                ? "R$ " + total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : "";
        }
    }
}
function openClientModal() {
  clientModal.style.display = "flex";
  document.body.style.overflow = "hidden";

  const modalBox = clientModal.querySelector(".modal");
  modalBox.style.maxHeight = "90vh";
  modalBox.style.overflowY = "auto";

  setTimeout(() => modalName.focus(), 100);
}

function closeClientModal() {
  clientModal.style.display = "none";
  document.body.style.overflow = "";

  const modalBox = clientModal.querySelector(".modal");
  modalBox.style.overflowY = "";
  modalBox.style.maxHeight = "";
}


document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activeQuickPanel.clientId) {
    activeQuickPanel = { clientId: null, type: null };
    renderBoard();
    return;
  }

  if (e.key === "Escape" && clientModal.style.display === "flex") {
    closeClientModal();
  }
});

document.addEventListener("click", (e) => {
    if (!activeQuickPanel.clientId) return;
    if (e.target.closest(".kanban-card")) return;

    activeQuickPanel = { clientId: null, type: null };
    renderBoard();
});

// ------------------------------------------------------
// SELECT CLIENTE
// ------------------------------------------------------
function selectClient(id) {
    selectedClient = clients.find(c => c.id === id);
    if (!selectedClient) return;

    modalName.value = selectedClient.name;
    setPhoneInputValue(modalPhone, selectedClient.phone || "");
    modalCity.value = selectedClient.citystate;
    modalStage.value = selectedClient.stage;

    if (modalValue) {
        if (selectedClient.deal_value != null && selectedClient.deal_value !== "") {
            const num = Number(selectedClient.deal_value);
            const safeNum = Number.isFinite(num) ? num : 0;
            modalValue.value = formatCurrencyMaskDigits(
                String(Math.round(safeNum * 100))
            );
        } else {
            modalValue.value = "";
        }
    }
    if (modalFollowUp) {
        if (selectedClient.follow_up_date) {
            // Converter timestamp (ms) para formato YYYY-MM-DD do input date
            const d = new Date(Number(selectedClient.follow_up_date));
            modalFollowUp.value = d.toISOString().slice(0, 10);
        } else {
            modalFollowUp.value = "";
        }
    }
    modalTags = Array.isArray(selectedClient.tags) ? selectedClient.tags : [];
    renderModalTags();

    modalNotes = Array.isArray(selectedClient.notes) ? selectedClient.notes : [];
    renderModalNotes();

    // Mostrar botão deletar só para clientes existentes
    if (modalDelete) modalDelete.style.display = "inline-flex";
}

// ------------------------------------------------------
// OPEN/CLOSE MODAL
// ------------------------------------------------------
// openClientModal e closeClientModal definidas acima (versão completa com scroll)

modalCancel.onclick = closeClientModal;

clientModal.addEventListener("click", e => {
    if (e.target === clientModal) closeClientModal();
});

// ------------------------------------------------------
// NOVO CLIENTE
// ------------------------------------------------------
document.getElementById("addClientBtn").addEventListener("click", () => {
    selectedClient = null;

    modalName.value = "";
    setPhoneInputValue(modalPhone, "");
    modalCity.value = "";
    modalStage.value = "Novo";

    if (modalValue) modalValue.value = "";
    if (modalFollowUp) modalFollowUp.value = "";
    modalTags = [];
    modalNotes = [];

    renderModalTags();
    renderModalNotes();

    // Ocultar botão deletar para novo cliente
    if (modalDelete) modalDelete.style.display = "none";

    openClientModal();
});

// ------------------------------------------------------
// ADICIONAR TAG
// ------------------------------------------------------
modalAddTag.onclick = () => {
    const tag = modalNewTag.value.trim();
    if (!tag) return;

    modalTags.push(tag);
    modalNewTag.value = "";
    renderModalTags();
};

// ------------------------------------------------------
// ADICIONAR NOTA
// ------------------------------------------------------
modalAddNote.onclick = () => {
    const text = modalNoteText.value.trim();
    if (!text) return;

    modalNotes.push({
        text,
        created_at: Date.now()
    });

    modalNoteText.value = "";
    renderModalNotes();
};


// ------------------------------------------------------
// DELETAR CLIENTE
// ------------------------------------------------------
modalDelete?.addEventListener("click", async () => {
    if (!selectedClient?.id) return;

    const confirmed = confirm(`Excluir "${selectedClient.name}"?\n\nEsta ação não pode ser desfeita.`);
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/crm/delete/${selectedClient.id}`, {
            method: "DELETE"
        });

    const data = await res.json();

    if (!data.ok) {
        return showToast("Erro ao excluir cliente", "error");
    }

        showToast("Cliente excluído!");
        closeClientModal();
        loadClients(true);

    } catch (err) {
        showToast("Erro ao excluir cliente", "error");
    }
});

// ------------------------------------------------------
// SALVAR CLIENTE (CRIAR / EDITAR)
// ------------------------------------------------------
function parseDealValue(rawInput) {
    const raw = String(rawInput ?? "").trim();
    if (!raw) return null;
    const parsed = parseCurrencyInput(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

modalSave.addEventListener("click", async () => {
    if (typeof clearAllFieldErrors === "function") clearAllFieldErrors(document);
    if (typeof setButtonLoading === "function") setButtonLoading(modalSave, true, "Salvando...");

    const body = {
        name: modalName.value.trim(),
        phone: getPhoneDigits(modalPhone.value),
        citystate: modalCity.value.trim(),
        stage: modalStage.value,
        tags: JSON.stringify(modalTags),
        notes: JSON.stringify(modalNotes),
        deal_value: parseDealValue(modalValue?.value),
        follow_up_date: modalFollowUp?.value
            ? new Date(modalFollowUp.value + "T00:00:00").getTime()
            : null
    };

    let savedOk = false;
    let hasError = false;

    if (!body.name) {
        if (typeof showFieldError === "function") showFieldError(modalName, "Nome obrigatório.");
        hasError = true;
    }
    if (!body.phone) {
        if (typeof showFieldError === "function") showFieldError(modalPhone, "Telefone obrigatório.");
        hasError = true;
    } else if (!isValidBrazilPhone(body.phone)) {
        if (typeof showFieldError === "function") {
            showFieldError(modalPhone, `Informe um WhatsApp com DDI ${PHONE_BR_PREFIX} e DDD.`);
        }
        hasError = true;
    }

    if (hasError) {
        showToast("Revise os campos obrigatórios antes de salvar.", "error");
        if (typeof setButtonLoading === "function") setButtonLoading(modalSave, false);
        return;
    }

    try {
        if (selectedClient?.id) {
            body.id = selectedClient.id;

            const res = await fetch("/api/crm/update", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok || data.ok === false) throw new Error(data.error || "Erro ao atualizar cliente");
            showToast("Cliente atualizado!");
            savedOk = true;
        } else {
            const res = await fetch("/api/crm/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok || data.ok === false) throw new Error(data.error || "Erro ao criar cliente");
            showToast("Cliente criado!");
            savedOk = true;
        }

    } catch (err) {
        console.error(err);
        showToast(err?.message || "Erro ao salvar cliente", "error");
    } finally {
        if (!hasError) {
            try { closeClientModal(); } catch {}
        }
        if (savedOk) {
            try { await loadClients(true); } catch (err) { console.error("Erro ao recarregar clientes:", err); }
        }
        if (typeof setButtonLoading === "function") setButtonLoading(modalSave, false);
    }
});

// ------------------------------------------------------
// DRAG & DROP
// ------------------------------------------------------
let draggedCard = null;

function onCardDragStart(e) {
    if (activeQuickPanel.clientId) {
        activeQuickPanel = { clientId: null, type: null };
    }
    draggedCard = e.currentTarget;
    draggedCard.classList.add("dragging");
}

function onCardDragEnd() {
    draggedCard?.classList.remove("dragging");
    draggedCard = null;
}

document.querySelectorAll(".kanban-dropzone").forEach(zone => {
    zone.addEventListener("dragover", e => e.preventDefault());

    zone.addEventListener("drop", async e => {
        e.preventDefault();
        if (!draggedCard) return;

        const id = Number(draggedCard.dataset.id);
        const stage = zone.dataset.stage;
        const c = clients.find(x => x.id === id);

        if (c && normalizeStage(c.stage) === stage) return;

        try {
            const res = await fetch("/api/crm/stage", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, stage })
            });
            const data = await res.json();

            if (!res.ok || data.ok === false) {
                throw new Error(data.error || "Erro ao atualizar estágio");
            }

            if (c) c.stage = stage;

            renderBoard();
            notifyCrmChanged();

        } catch (err) {
            showToast("Erro ao atualizar estágio", "error");
        }
    });

});
/* =====================================
   TOGGLE DE COLUNAS COM ANIMAÇÃO
===================================== */

const stageMap = {
  filterNovo: "Novo",
  filterQualificando: "Qualificando",
  filterNegociacao: "Negociação",
  filterFechado: "Fechado",
  filterPerdido: "Perdido"
};

Object.entries(stageMap).forEach(([checkboxId, stage]) => {
  const checkbox = document.getElementById(checkboxId);
  const column = document.querySelector(
    `.kanban-column[data-stage="${stage}"]`
  );

  if (!checkbox || !column) return;

  // estado inicial
  if (!checkbox.checked) {
    column.classList.add("is-hidden");
  }

  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      column.classList.remove("is-hidden");
    } else {
      column.classList.add("is-hidden");
    }
  });
});



// ------------------------------------------------------
// EVENTOS
// ------------------------------------------------------
refreshBtn?.addEventListener("click", () => loadClients(true));

[
    filterNovo,
    filterQualificando,
    filterNegociacao,
    filterFechado,
    filterPerdido
].forEach(f => f?.addEventListener("change", renderBoard));


// ------------------------------------------------------
// EXPORTAR CSV
// ------------------------------------------------------
function getFilteredClients() {
    return applyFilters();
}

function exportCSV() {
    const data = getSortedClients(getFilteredClients());

    if (!data.length) {
        showToast("Nenhum cliente para exportar", "error");
        return;
    }

    const headers = ["Nome", "Telefone", "Cidade/Estado", "Estágio", "Tags", "Notas", "Última atividade"];

    const rows = data.map(c => {
        const tags  = getClientTags(c).join("; ");
        const notes = Array.isArray(c.notes) ? c.notes.map(n => n.text).join("; ") : "";
        const lastSeen = c.last_seen ? new Date(c.last_seen).toLocaleDateString("pt-BR") : "";

        // Escapar aspas duplas nos campos
        const escape = v => `"${String(v || "").replace(/"/g, '""')}"`;

        return [
            escape(c.name),
            escape(c.phone),
            escape(c.citystate),
            escape(c.stage),
            escape(tags),
            escape(notes),
            escape(lastSeen)
        ].join(",");
    });

    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }); // BOM para Excel
    const url  = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `crm_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();

    URL.revokeObjectURL(url);
    showToast(`${data.length} cliente(s) exportado(s)!`);
}

document.getElementById("exportBtn")?.addEventListener("click", exportCSV);



// ------------------------------------------------------
// FILTRO POR TAG
// ------------------------------------------------------
function setActiveTag(tag) {
    if (!tag) {
        activeFilters = { ...activeFilters, tags: [] };
    } else {
        const normalizedTag = String(tag).trim();
        const nextTags = activeFilters.tags.includes(normalizedTag)
            ? activeFilters.tags.filter((item) => item !== normalizedTag)
            : [...activeFilters.tags, normalizedTag];
        activeFilters = { ...activeFilters, tags: nextTags };
    }

    renderFilterPills();
    renderBoard();
}

// ------------------------------------------------------
// ORDENAÇÃO DAS COLUNAS
// ------------------------------------------------------
const sortSelect = document.getElementById("sortSelect");
const sortDirBtn = document.getElementById("sortDirBtn");

sortSelect?.addEventListener("change", () => {
    sortBy = sortSelect.value;
    renderBoard();
});

sortDirBtn?.addEventListener("click", () => {
    sortDir = sortDir === "asc" ? "desc" : "asc";
    sortDirBtn.textContent = sortDir === "asc" ? "↑ Asc" : "↓ Desc";
    renderBoard();
});

document.getElementById("crmLoadMore")?.addEventListener("click", loadMoreClients);

// ------------------------------------------------------
// INIT
// ------------------------------------------------------
loadClients();



