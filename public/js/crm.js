// ======================================================
// CRM KANBAN — JS COMPLETO E CORRIGIDO
// ======================================================

let clients = [];
let selectedClient = null;

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

const modalSave = document.getElementById("modalSave");
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
        const div = document.createElement("div");
        div.className = "tag";
        div.innerHTML = `${tag} <span class="remove-tag" data-i="${index}">x</span>`;
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
        clients = await res.json();
        renderBoard();
    } catch (err) {
        showToast("Erro ao carregar clientes", "error");
    }
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

    clients.forEach(c => {
        const stage = c.stage || "Novo";

        // filtros
        if (stage === "Novo" && !filterNovo.checked) return;
        if (stage === "Qualificando" && !filterQualificando.checked) return;
        if ((stage === "Negociação" || stage === "Negociacao") && !filterNegociacao.checked) return;
        if (stage === "Fechado" && !filterFechado.checked) return;
        if (stage === "Perdido" && !filterPerdido.checked) return;

        // busca
        const tags = c.tags ? JSON.parse(c.tags) : [];
        const haystack = [
            c.name || "",
            c.phone || "",
            c.citystate || "",
            ...tags
        ].join(" ").toLowerCase();

        if (search && !haystack.includes(search)) return;

        const zoneName = stage === "Negociacao" ? "Negociação" : stage;
        const zone = stages[zoneName];
        counts[zoneName]++;

        const card = document.createElement("div");
        card.className = "kanban-card";
        card.draggable = true;
        card.dataset.id = c.id;

        card.innerHTML = `
          <div class="card-name">${c.name || "Sem nome"}</div>
          <div class="card-meta">
             <span>${c.phone}</span>
             <span>${c.citystate}</span>
          </div>
          <div class="card-tags">
            ${tags.slice(0, 3).map(t => `<span class="tag">${t}</span>`).join("")}
            ${tags.length > 3 ? `<span class="tag more">+${tags.length - 3}</span>` : ""}
          </div>
       `;

        card.addEventListener("click", () => {
            selectClient(c.id);
            openClientModal();
        });

        // drag events
        card.addEventListener("dragstart", onCardDragStart);
        card.addEventListener("dragend", onCardDragEnd);

        zone.appendChild(card);
    });

    // contadores
    for (const k in counts) {
        const el = document.getElementById("count-" + k);
        if (el) el.innerText = counts[k];
    }
}
function openClientModal() {
  clientModal.style.display = "flex";

  // trava scroll do body
  document.body.style.overflow = "hidden";

  // ativa scroll interno do modal
  const modalBox = clientModal.querySelector(".modal");
  modalBox.style.maxHeight = "90vh";
  modalBox.style.overflowY = "auto";

  // foco automático
  setTimeout(() => modalName.focus(), 100);
}

function closeClientModal() {
  clientModal.style.display = "none";

  // libera scroll do body
  document.body.style.overflow = "";

  // opcional: limpa estilos inline
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

    modalTags = selectedClient.tags ? JSON.parse(selectedClient.tags) : [];
    renderModalTags();

    modalNotes = selectedClient.notes ? JSON.parse(selectedClient.notes) : [];
    renderModalNotes();
}

// ------------------------------------------------------
// OPEN/CLOSE MODAL
// ------------------------------------------------------
function openClientModal() {
    clientModal.style.display = "flex";
}

function closeClientModal() {
    clientModal.style.display = "none";
}

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

    modalTags = [];
    modalNotes = [];

    renderModalTags();
    renderModalNotes();

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
// SALVAR CLIENTE (CRIAR / EDITAR)
// ------------------------------------------------------
modalSave.addEventListener("click", async () => {
    const body = {
        name: modalName.value.trim(),
        phone: modalPhone.value.trim(),
        citystate: modalCity.value.trim(),
        stage: modalStage.value,
        tags: JSON.stringify(modalTags),
        notes: JSON.stringify(modalNotes)
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
// INIT
// ------------------------------------------------------
loadClients();
