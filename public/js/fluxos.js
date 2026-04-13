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
  const flowActive = document.getElementById("flowActive");
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
            <span style="font-size:12px;color:${f.active ? '#22c55e' : '#f97316'};margin-right:8px;">${f.active ? 'Ativo' : 'Pausado'}</span>
            <button data-id="${f.id}" class="test-btn">🧪</button>
            <button data-id="${f.id}" class="edit-btn">✏️</button>
            <button data-id="${f.id}" class="toggle-btn">${f.active ? '⏸' : '▶️'}</button>
            <button data-id="${f.id}" class="del-btn">🗑️</button>
          </div>
        </div>
        <div style="margin-top:6px;color:#94a3b8">trigger(s): ${(f.triggers ? JSON.parse(f.triggers) : [f.trigger]).join(", ")}</div>
        <div class="actions-list">
          ${(JSON.parse(f.actions) || []).slice(0,3).map(a => `<div class="action-item">${a.type}${a.payload ? `: ${String(a.payload).slice(0,50)}` : ''}</div>`).join('')}
        </div>
      `;
      flowsWrap.appendChild(card);
    });
    // listeners
    document.querySelectorAll(".edit-btn").forEach(b => b.onclick = e => openEdit(Number(b.dataset.id)));
    document.querySelectorAll(".del-btn").forEach(b => b.onclick = e => delFlow(Number(b.dataset.id)));
    document.querySelectorAll(".toggle-btn").forEach(b => b.onclick = () => toggleFlow(Number(b.dataset.id)));
    document.querySelectorAll(".test-btn").forEach(b => b.onclick = () => testFlow(Number(b.dataset.id)));
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
    if (flowActive) flowActive.checked = true;
    renderActions();
    modal.style.display = "flex";
  }

  function openEdit(id){
    const f = flows.find(x => x.id === id);
    if (!f) return;
    editing = f;
    modalTitle.innerText = "Editar Fluxo";
    flowName.value = f.name;
    flowTrigger.value = (f.triggers ? JSON.parse(f.triggers)[0] : f.trigger) || "";
    if (flowActive) flowActive.checked = f.active !== 0;
    actions = JSON.parse(f.actions || "[]");
    renderActions();
    modal.style.display = "flex";
    // também popula editor visual se aberto
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
    clearAllFieldErrors(document);
    const name = flowName.value.trim();
    const trigger = flowTrigger.value.trim();
    if (!name || !trigger) {
      if (!name) showFieldError(flowName, "Nome obrigatório.");
      if (!trigger) showFieldError(flowTrigger, "Trigger obrigatório.");
      return;
    }
    const active = flowActive ? flowActive.checked : true;
    const payload = { name, trigger, actions, active };
    setButtonLoading(btnSave, true, editing ? "Salvando..." : "Criando...");
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
    } finally {
      setButtonLoading(btnSave, false);
    }
  };

  btnCancel.onclick = closeModal;

  async function delFlow(id){
    if (!confirm("Deletar fluxo?")) return;
    await fetch("/api/flows/delete", { method: "DELETE", headers: { "Content-Type":"application/json" }, body: JSON.stringify({ id }) });
    await fetchList();
  }

  async function toggleFlow(id){
    const f = flows.find(x => x.id === id);
    if (!f) return;
    const next = f.active ? 0 : 1;
    await fetch("/api/flows/active", {
      method: "PUT",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ id, active: next })
    });
    await fetchList();
  }

  async function testFlow(id){
    const message = prompt("Digite a mensagem de teste:");
    if (!message) return;
    try {
      const res = await fetch("/api/flows/test", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ id, message })
      });
      const data = await res.json();
      if (!data.ok) {
        return alert("Falha ao testar fluxo");
      }
      if (!data.matched) {
        return alert("Nenhum trigger combinou com a mensagem.");
      }
      if (!data.conditionPassed) {
        return alert("Triggers combinaram, mas as condições do fluxo falharam.");
      }
      const logs = (data.logs || []).join("\n");
      alert(`Fluxo executaria:\n${logs || "(sem ações)"}`);
    } catch (err) {
      alert("Erro ao testar fluxo");
    }
  }

  btnNew.onclick = openNew;
  // abrir editor visual por fluxo
  window.addEventListener('visualFlowUpdate', (ev) => {
    const { id, actions: newActions } = ev.detail || {};
    if (!id || !newActions) return;
    const f = flows.find(x => x.id === id);
    if (f) {
      f.actions = JSON.stringify(newActions);
      actions = newActions;
      if (editing && editing.id === id) {
        renderActions();
      }
      alert("Fluxo visual aplicado. Clique em Salvar para persistir.");
    }
  });

  // fecha modal clicando fora
  modal.onclick = e => { if (e.target === modal) closeModal(); };

  // init
  await fetchList();
})();
