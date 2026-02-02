// public/js/flows.js
(async () => {
  const flowsWrap = document.getElementById("flowsWrap");
  const btnNew = document.getElementById("btnNewFlow");
  const modal = document.getElementById("flowModal");
  const modalTitle = document.getElementById("flowModalTitle");
  const flowName = document.getElementById("flowName");
  const flowTrigger = document.getElementById("flowTrigger");
  const flowActions = document.getElementById("flowActions");
  const addActionType = document.getElementById("addActionType");
  const btnAddAction = document.getElementById("btnAddAction");
  const btnSave = document.getElementById("flowSave");
  const btnCancel = document.getElementById("flowCancel");
  const user = JSON.parse(document.getElementById("userdata").dataset.user);


  let flows = [];
  let editing = null;
  let actions = [];

  function renderFlows() {
    flowsWrap.innerHTML = "";
    flows.forEach(f => {
      const card = document.createElement("div");
      card.className = "flow-card";
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${f.name}</strong>
          <div>
            <button data-id="${f.id}" class="edit-btn">✏️</button>
            <button data-id="${f.id}" class="del-btn">🗑️</button>
          </div>
        </div>
        <div style="margin-top:6px;color:#94a3b8">trigger: ${f.trigger}</div>
        <div class="actions-list">
          ${(JSON.parse(f.actions) || []).slice(0,3).map(a => `<div class="action-item">${a.type}${a.payload ? `: ${String(a.payload).slice(0,50)}` : ''}</div>`).join('')}
        </div>
      `;
      flowsWrap.appendChild(card);
    });
    // listeners
    document.querySelectorAll(".edit-btn").forEach(b => b.onclick = e => openEdit(Number(b.dataset.id)));
    document.querySelectorAll(".del-btn").forEach(b => b.onclick = e => delFlow(Number(b.dataset.id)));
  }

  async function fetchList(){
    const res = await fetch("/api/flows/list");
    const data = await res.json();
    if (data.ok) {
      flows = data.flows;
      renderFlows();
    }
  }

  function openNew(){
    editing = null;
    actions = [];
    modalTitle.innerText = "Novo Fluxo";
    flowName.value = "";
    flowTrigger.value = "";
    renderActions();
    modal.style.display = "flex";
  }

  function openEdit(id){
    const f = flows.find(x => x.id === id);
    if (!f) return;
    editing = f;
    modalTitle.innerText = "Editar Fluxo";
    flowName.value = f.name;
    flowTrigger.value = f.trigger;
    actions = JSON.parse(f.actions || "[]");
    renderActions();
    modal.style.display = "flex";
  }

  function closeModal(){ modal.style.display = "none"; }

  function renderActions(){
    flowActions.innerHTML = "";
    actions.forEach((a, i) => {
      const div = document.createElement("div");
      div.className = "action-item";
      div.innerHTML = `
        <div style="flex:1">
          <strong>${a.type}</strong>
          <div>${a.payload ? (typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload)) : ''}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button data-i="${i}" class="up">▲</button>
          <button data-i="${i}" class="down">▼</button>
          <button data-i="${i}" class="edit">✏️</button>
          <button data-i="${i}" class="rm">✖</button>
        </div>
      `;
      flowActions.appendChild(div);
    });

    flowActions.querySelectorAll(".up").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.i);
      if (i<=0) return;
      [actions[i-1], actions[i]] = [actions[i], actions[i-1]];
      renderActions();
    });
    flowActions.querySelectorAll(".down").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.i);
      if (i>=actions.length-1) return;
      [actions[i+1], actions[i]] = [actions[i], actions[i+1]];
      renderActions();
    });
    flowActions.querySelectorAll(".rm").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.i);
      actions.splice(i,1);
      renderActions();
    });
    flowActions.querySelectorAll(".edit").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.i);
      editAction(i);
    });
  }

  function editAction(i){
    const a = actions[i];
    const value = prompt("Edite o payload da ação (texto / url base64 / segundos):", a.payload || "");
    if (value === null) return;
    // simple cast for delay:
    if (a.type === "delay") {
      const n = Number(value);
      if (isNaN(n)) return alert("Valor inválido");
      a.payload = n;
    } else {
      a.payload = value;
    }
    renderActions();
  }

  btnAddAction.onclick = () => {
    const t = addActionType.value;
    let payload = "";
    if (t === "send_text") payload = "Digite a mensagem aqui";
    if (t === "delay") payload = 2;
    if (t === "send_media") payload = "data:...base64,...";
    if (t === "handover_human") payload = null;
    actions.push({ type: t, payload });
    renderActions();
  };
  

  btnSave.onclick = async () => {
    const name = flowName.value.trim();
    const trigger = flowTrigger.value.trim();
    if (!name || !trigger) return alert("Nome e trigger obrigatórios");
    const payload = { name, trigger, actions };
    try {
      if (editing) {
        await fetch("/api/flows/update", { method: "PUT", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ id: editing.id, ...payload }) });
      } else {
        await fetch("/api/flows/create", { method: "POST", headers: { "Content-Type":"application/json" }, body: JSON.stringify(payload) });
      }
      await fetchList();
      closeModal();
    } catch (err) {
      alert("Erro salvar");
    }
  };

  btnCancel.onclick = closeModal;

  async function delFlow(id){
    if (!confirm("Deletar fluxo?")) return;
    await fetch("/api/flows/delete", { method: "DELETE", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ id }) });
    await fetchList();
  }

  btnNew.onclick = openNew;
  // fecha modal clicando fora
  modal.onclick = e => { if (e.target === modal) closeModal(); };

  // init
  await fetchList();
})();
