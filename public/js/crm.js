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


// Toast
const toasts = document.getElementById("toasts");

// ------------------------------------------------------
// TOAST
// ------------------------------------------------------
function showToast(msg, type = "success") {
    const div = document.createElement("div");
    div.className = `toast ${type}`;
    div.innerText = msg;
    toasts.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

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
async function loadClients() {
  try {
    const res = await fetch("/api/crm/list");
    const data = await res.json();

    clients = data.clients || [];   // ✅
    renderBoard();
  } catch (err) {
    console.error(err);
    showToast("Erro ao carregar clientes", "error");
  }
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

    const search = (searchInput?.value || "").toLowerCase();
    const counts = { Novo: 0, Qualificando: 0, "Negociação": 0, Fechado: 0, Perdido: 0 };
    const values = { Novo: 0, Qualificando: 0, "Negociação": 0, Fechado: 0, Perdido: 0 };

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
        const stage = c.stage || "Novo";

        // filtros
        if (stage === "Novo" && !filterNovo.checked) return;
        if (stage === "Qualificando" && !filterQualificando.checked) return;
        if ((stage === "Negociação" || stage === "Negociacao") && !filterNegociacao.checked) return;
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

        const zoneName = stage === "Negociacao" ? "Negociação" : stage;
        const zone = stages[zoneName];
        counts[zoneName]++;
        values[zoneName] = (values[zoneName] || 0) + (Number(c.deal_value) || 0);

        const card = document.createElement("div");
        card.className = "kanban-card";
        card.draggable = true;
        card.dataset.id = c.id;

        // Formatar número para chatId (só dígitos + @c.us)
        const chatPhone = (c.phone || "").replace(/\D/g, "");

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
                ? `<img src="${c.avatar}" alt="${initials}" />`
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

    if (modalValue) modalValue.value = selectedClient.deal_value || "";
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
        closeClientModal();
        loadClients();

    } catch (err) {
        showToast("Erro ao excluir cliente", "error");
    }
});

// ------------------------------------------------------
// SALVAR CLIENTE (CRIAR / EDITAR)
// ------------------------------------------------------
modalSave.addEventListener("click", async () => {
    const body = {
        name: modalName.value.trim(),
        phone: modalPhone.value.trim(),
        citystate: modalCity.value.trim(),
        stage: modalStage.value,
        tags: JSON.stringify(modalTags),
        notes: JSON.stringify(modalNotes),
        deal_value: parseFloat(modalValue?.value || "0") || 0,
        follow_up_date: modalFollowUp?.value
            ? new Date(modalFollowUp.value + "T00:00:00").getTime()
            : null
    };

    if (!body.name || !body.phone) {
        return showToast("Nome e telefone obrigatórios!", "error");
    }

    try {
        if (selectedClient?.id) {
            body.id = selectedClient.id;

            await fetch("/api/crm/update", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            showToast("Cliente atualizado!");
        } else {
            await fetch("/api/crm/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });

            showToast("Cliente criado!");
        }

        closeClientModal();
        loadClients();

    } catch (err) {
        showToast("Erro ao salvar cliente", "error");
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
refreshBtn?.addEventListener("click", loadClients);
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
        const stage = c.stage || "Novo";

        // Aplicar mesmos filtros do renderBoard
        if (stage === "Novo"          && !filterNovo.checked)          return false;
        if (stage === "Qualificando"  && !filterQualificando.checked)  return false;
        if ((stage === "Negociação" || stage === "Negociacao") && !filterNegociacao.checked) return false;
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
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }); // BOM para Excel
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

// ------------------------------------------------------
// INIT
// ------------------------------------------------------
loadClients();