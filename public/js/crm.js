// ======================================================
// CRM KANBAN — JS COMPLETO E CORRIGIDO
// ======================================================

let clients = [];
let selectedClient = null;
let sortBy = "name"; // "name" | "last_seen" | "follow_up" | "value"
let sortDir = "asc"; // "asc" | "desc"
let activeTag = null; // tag clicada para filtrar

let modalTags = [];
let modalNotes = [];
let viewMode = "kanban"; // "kanban" | "list"
let currentPage = 1;
let totalPages = 1;
let isLoading = false;
const PAGE_SIZE = 100;

// ------------------------------------------------------
// SOCKET.IO (atualização em tempo real)
// ------------------------------------------------------
let socket = null;
try {
    socket = io({ auth: { userId: window.USER_ID } });
    socket.on("crm:changed", () => {
        loadClients();
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

// ------------------------------------------------------
// ELEMENTOS
// ------------------------------------------------------
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("q");

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

// Busca com debounce
let searchDebounce = null;
searchInput?.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadClients(true), 250);
});

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
        div.innerHTML = `${tag} <span class="remove-tag" data-i="${index}" style="opacity:.6;cursor:pointer;">✕</span>`;
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
            `<b>${new Date(n.created_at).toLocaleString()}</b><br>${n.text}`;
        modalNotesWrap.appendChild(div);
    });
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
    renderBoard();
  }

  if (currentPage > totalPages) return;

  isLoading = true;
  try {
    const term = (searchInput?.value || "").trim();
    const qs = new URLSearchParams({
      page: String(currentPage),
      pageSize: String(PAGE_SIZE),
    });
    if (term) qs.set("term", term);

    const res = await fetch(`/api/crm/list?${qs.toString()}`);
    const data = await res.json();

    if (reset) clients = [];
    clients = clients.concat(data.clients || []);
    currentPage = data.page || currentPage;
    totalPages = data.totalPages || 1;

    toggleLoadMore();
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
    return `<span
        class="tag${extraClass}${activeClass}"
        data-tag="${t}"
        style="background:${activeBg};color:${activeColor};border:1px solid ${activeBorder};"
    >${t}</span>`;
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

    const search = (searchInput?.value || "").toLowerCase();
    const counts = { Novo: 0, Qualificando: 0, "Negociação": 0, Fechado: 0, Perdido: 0 };
    const values = { Novo: 0, Qualificando: 0, "Negociação": 0, Fechado: 0, Perdido: 0 };
    let rendered = 0;

    // Ordenar antes de renderizar
    const sorted = [...clients].sort((a, b) => {
        let va, vb;
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
        if (va > vb) return sortDir === "asc" ?  1 : -1;
        return 0;
    });

    sorted.forEach(c => {
        const stage = normalizeStage(c.stage);

        // filtros
        if (stage === "Novo" && !filterNovo.checked) return;
        if (stage === "Qualificando" && !filterQualificando.checked) return;
        if (stage === "Negociação" && !filterNegociacao.checked) return;
        if (stage === "Fechado" && !filterFechado.checked) return;
        if (stage === "Perdido" && !filterPerdido.checked) return;

        // busca
        const tags = Array.isArray(c.tags) ? c.tags : [];
        const haystack = [
            c.name || "",
            c.phone || "",
            c.citystate || "",
            ...tags
        ].join(" ").toLowerCase();

        if (search && !haystack.includes(search)) return;

        // filtro por tag clicada
        if (activeTag && !tags.includes(activeTag)) return;

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

            item.innerHTML = `
              <h3>${c.name || "Sem nome"}</h3>
              <div class="list-cta">
                <a href="/chat?contact=${chatPhone}" target="_blank">Abrir chat</a>
                <button data-id="${c.id}" class="btn-list-edit">Editar</button>
              </div>
              <div class="list-meta">
                ${c.phone || ""} • ${c.citystate || "Cidade não informada"}
              </div>
              <div class="list-meta">
                ${valueStr ? `<span>${valueStr}</span>` : ""}
                ${fupLabel ? `<span>Follow-up: ${fupLabel}</span>` : ""}
                ${c.stage ? `<span class="list-stage" style="background:${stageColor}20;color:${stageColor};border:1px solid ${stageColor}40;">${zoneName}</span>` : ""}
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

        // Valor formatado
        const valueStr = Number(c.deal_value) > 0
            ? "R$ " + Number(c.deal_value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "";

        card.innerHTML = `
          <div class="card-inner">

            <!-- Topo: avatar + nome + valor -->
          <div class="card-top">
            <div class="card-avatar">${c.avatar
                ? `<img src="${c.avatar}" alt="${initials}" loading="lazy" />`
                : `<span>${initials}</span>`}
            </div>
              <div class="card-info">
                <div class="card-name">${c.name || "Sem nome"}</div>
                <div class="card-phone">
                  <i class="fa-solid fa-phone"></i>
                  ${c.phone || "—"}
                </div>
              </div>
              ${valueStr ? `<div class="card-value">${valueStr}</div>` : ""}
            </div>

            <!-- Localização -->
            ${c.citystate ? `
            <div class="card-location">
              <i class="fa-solid fa-location-dot"></i>
              ${c.citystate}
            </div>` : ""}

            <!-- Tags -->
            ${tags.length > 0 ? `
            <div class="card-tags">
              ${tags.slice(0, 3).map(t => renderTag(t, true, activeTag === t)).join("")}
              ${tags.length > 3 ? `<span class="tag more">+${tags.length - 3}</span>` : ""}
            </div>` : ""}

            <!-- Follow-up -->
            ${fupLabel ? `
            <div class="card-followup ${fupOverdue ? "overdue" : fupToday ? "today" : ""}">
              <i class="fa-solid fa-clock"></i>
              ${fupOverdue ? "Vencido: " : fupToday ? "Hoje: " : "Retorno: "}${fupLabel}
            </div>` : ""}

            <!-- Footer: botão chat -->
            <div class="card-footer">
              <a href="/chat?contact=${chatPhone}" class="btn-open-chat" title="Abrir chat" onclick="event.stopPropagation()">
                <i class="fa-brands fa-whatsapp"></i> Chat
              </a>
            </div>

          </div>
        `;

        card.addEventListener("click", (e) => {
            // Se clicou em uma tag, filtrar por ela
            const tagEl = e.target.closest(".tag-clickable");
            if (tagEl) {
                e.stopPropagation();
                const tag = tagEl.dataset.tag;
                setActiveTag(activeTag === tag ? null : tag); // toggle
                return;
            }
            selectClient(c.id);
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
  if (e.key === "Escape" && clientModal.style.display === "flex") {
    closeClientModal();
  }
});

// ------------------------------------------------------
// SELECT CLIENTE
// ------------------------------------------------------
function selectClient(id) {
    selectedClient = clients.find(c => c.id === id);
    if (!selectedClient) return;

    modalName.value = selectedClient.name;
    modalPhone.value = selectedClient.phone;
    modalCity.value = selectedClient.citystate;
    modalStage.value = selectedClient.stage;

    if (modalValue) {
        if (selectedClient.deal_value != null && selectedClient.deal_value !== "") {
            const num = Number(selectedClient.deal_value);
            const safeNum = Number.isFinite(num) ? num : 0;
            // input type="number" precisa de ponto decimal (não vírgula)
            modalValue.value = safeNum.toFixed(2);
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
    modalPhone.value = "";
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
        notifyCrmChanged();
        closeClientModal();
        loadClients();

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
    // aceita formatos "1.234,56" ou "1234.56"
    const normalized = raw
        .replace(/\s+/g, "")
        .replace(/\.(?=\d{3}(,|$))/g, "") // remove pontos de milhar
        .replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

modalSave.addEventListener("click", async () => {
    if (typeof clearAllFieldErrors === "function") clearAllFieldErrors(document);
    if (typeof setButtonLoading === "function") setButtonLoading(modalSave, true, "Salvando...");

    const body = {
        name: modalName.value.trim(),
        phone: modalPhone.value.trim(),
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
    }

    if (hasError) {
        showToast("Nome e telefone obrigatórios!", "error");
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
            notifyCrmChanged();
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
            notifyCrmChanged();
        }

    } catch (err) {
        console.error(err);
        showToast(err?.message || "Erro ao salvar cliente", "error");
    } finally {
        if (!hasError) {
            try { closeClientModal(); } catch {}
        }
        if (savedOk) {
            try { await loadClients(); } catch (err) { console.error("Erro ao recarregar clientes:", err); }
        }
        if (typeof setButtonLoading === "function") setButtonLoading(modalSave, false);
    }
});

// ------------------------------------------------------
// DRAG & DROP
// ------------------------------------------------------
let draggedCard = null;

function onCardDragStart(e) {
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

        try {
            await fetch("/api/crm/stage", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, stage })
            });

            const c = clients.find(x => x.id === id);
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
searchInput?.addEventListener("input", renderBoard);

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
    const search = (searchInput?.value || "").toLowerCase();

    return clients.filter(c => {
        const stage = normalizeStage(c.stage);

        // Aplicar mesmos filtros do renderBoard
        if (stage === "Novo"          && !filterNovo.checked)          return false;
        if (stage === "Qualificando"  && !filterQualificando.checked)  return false;
        if (stage === "Negociação" && !filterNegociacao.checked) return false;
        if (stage === "Fechado"       && !filterFechado.checked)       return false;
        if (stage === "Perdido"       && !filterPerdido.checked)       return false;

        // Busca
        if (search) {
            const tags = Array.isArray(c.tags) ? c.tags : [];
            const haystack = [c.name, c.phone, c.citystate, ...tags]
                .join(" ").toLowerCase();
            if (!haystack.includes(search)) return false;
        }

        return true;
    });
}

function exportCSV() {
    const data = getFilteredClients();

    if (!data.length) {
        showToast("Nenhum cliente para exportar", "error");
        return;
    }

    const headers = ["Nome", "Telefone", "Cidade/Estado", "Estágio", "Tags", "Notas", "Última atividade"];

    const rows = data.map(c => {
        const tags  = Array.isArray(c.tags)  ? c.tags.join("; ")  : "";
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

    const csv = [headers.join(","), ...rows].join("");
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
    activeTag = tag;

    // Atualizar badge de filtro ativo
    const badge = document.getElementById("activeTagBadge");
    const label = document.getElementById("activeTagLabel");

    if (tag) {
        if (badge) badge.style.display = "flex";
        if (label) label.textContent = tag;
    } else {
        if (badge) badge.style.display = "none";
    }

    renderBoard();
}

document.getElementById("clearTagFilter")?.addEventListener("click", () => {
    setActiveTag(null);
});

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



