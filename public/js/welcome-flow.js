(() => {
  const statusEl = document.getElementById("welcomeStatus");
  const listEl = document.getElementById("welcomeActions");
  const btnEdit = document.getElementById("btnWelcomeEdit");
  const btnToggle = document.getElementById("btnWelcomeToggle");
  const btnTest = document.getElementById("btnWelcomeTest");

  const modal = document.getElementById("welcomeModal");
  const nameInput = document.getElementById("welcomeName");
  const activeInput = document.getElementById("welcomeActive");
  const actionsWrap = document.getElementById("welcomeModalActions");
  const addActionType = document.getElementById("welcomeAddActionType");
  const btnAddAction = document.getElementById("welcomeAddAction");
  const btnSave = document.getElementById("welcomeSave");
  const btnCancel = document.getElementById("welcomeCancel");

  if (!statusEl) return; // página errada

  let welcome = { id: null, name: "Boas-vindas", actions: [], active: true };
  let actions = [];

  const labelMap = {
    send_text: "Enviar texto",
    delay: "Aguardar",
    send_media: "Enviar mídia",
    handover_human: "Encaminhar humano",
    update_crm: "Atualizar CRM",
    call_webhook: "Webhook",
  };

  function actionPreview(a) {
    if (!a) return "";
    if (a.type === "delay") return `${labelMap[a.type]} (${a.payload || 1}s)`;
    if (a.type === "send_text") return `${labelMap[a.type]}: ${String(a.payload || "").slice(0, 60)}`;
    if (a.type === "send_media") return `${labelMap[a.type]}`;
    if (a.type === "update_crm") return `${labelMap[a.type]}: ${JSON.stringify(a.payload || {})}`;
    if (a.type === "call_webhook") return `${labelMap[a.type]}: ${a.payload?.url || ""}`;
    return labelMap[a.type] || a.type;
  }

  function renderCard() {
    statusEl.textContent = welcome.active ? "Ativado para novos contatos" : "Desativado";
    statusEl.style.color = welcome.active ? "#22c55e" : "#f97316";

    listEl.innerHTML = "";
    if (!actions.length) {
      listEl.innerHTML = `<div class="action-item">Nenhuma ação configurada.</div>`;
      return;
    }
    actions.slice(0, 4).forEach((a) => {
      const div = document.createElement("div");
      div.className = "action-item";
      div.textContent = actionPreview(a);
      listEl.appendChild(div);
    });
    if (actions.length > 4) {
      const extra = document.createElement("div");
      extra.style.color = "#94a3b8";
      extra.textContent = `+ ${actions.length - 4} ações`;
      listEl.appendChild(extra);
    }
  }

  function renderModalActions() {
    actionsWrap.innerHTML = "";
    actions.forEach((a, i) => {
      const div = document.createElement("div");
      div.className = "action-item";
      div.innerHTML = `
        <div style="flex:1">
          <strong>${labelMap[a.type] || a.type}</strong>
          <div style="color:#cbd5e1;">${actionPreview(a)}</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button data-i="${i}" class="up">Up</button>
          <button data-i="${i}" class="down">Down</button>
          <button data-i="${i}" class="edit">Edit</button>
          <button data-i="${i}" class="rm">Del</button>
        </div>
      `;
      actionsWrap.appendChild(div);
    });

    actionsWrap.querySelectorAll(".up").forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        if (i <= 0) return;
        [actions[i - 1], actions[i]] = [actions[i], actions[i - 1]];
        renderModalActions();
      };
    });
    actionsWrap.querySelectorAll(".down").forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        if (i >= actions.length - 1) return;
        [actions[i + 1], actions[i]] = [actions[i], actions[i + 1]];
        renderModalActions();
      };
    });
    actionsWrap.querySelectorAll(".rm").forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        actions.splice(i, 1);
        renderModalActions();
      };
    });
    actionsWrap.querySelectorAll(".edit").forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        const a = actions[i];
        if (!a) return;
        let value = "";
        if (a.type === "delay") {
          value = prompt("Quantos segundos aguardar?", a.payload || 1);
          const n = Number(value);
          if (!Number.isFinite(n)) return;
          a.payload = n;
        } else if (a.type === "update_crm") {
          const stage = prompt("Atualizar stage (opcional):", a.payload?.stage || "") || "";
          const tag = prompt("Adicionar tag (opcional):", a.payload?.tag || "") || "";
          const note = prompt("Adicionar nota (opcional):", a.payload?.note || "") || "";
          a.payload = { stage, tag, note };
        } else if (a.type === "call_webhook") {
          const url = prompt("URL do webhook:", a.payload?.url || "") || "";
          const timeout = Number(prompt("Timeout (ms):", a.payload?.timeout_ms || 8000) || 8000);
          a.payload = { ...(a.payload || {}), url, timeout_ms: timeout };
        } else {
          value = prompt("Payload da ação:", a.payload || "");
          if (value === null) return;
          a.payload = value;
        }
        renderModalActions();
      };
    });
  }

  async function fetchFlow() {
    try {
      const res = await fetch("/api/welcome-flow");
      const data = await res.json();
      if (data?.flow) {
        welcome = {
          id: data.flow.id,
          name: data.flow.name || "Boas-vindas",
          active: data.flow.active === 1 || data.flow.active === true,
          actions: data.flow.actions ? JSON.parse(data.flow.actions) : [],
        };
      } else {
        welcome = { id: null, name: "Boas-vindas", actions: [], active: true };
      }
      actions = Array.isArray(welcome.actions) ? [...welcome.actions] : [];
      renderCard();
    } catch (err) {
      statusEl.textContent = "Erro ao carregar";
      statusEl.style.color = "#ef4444";
    }
  }

  function openModal() {
    nameInput.value = welcome.name || "Boas-vindas";
    activeInput.checked = !!welcome.active;
    actions = Array.isArray(welcome.actions) ? [...welcome.actions] : [];
    renderModalActions();
    modal.style.display = "flex";
  }

  function closeModal() {
    modal.style.display = "none";
  }

  async function saveFlow(payload) {
    await fetch("/api/welcome-flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  btnAddAction.onclick = () => {
    const t = addActionType.value;
    let payload = "";
    if (t === "send_text") payload = "Digite a mensagem de boas-vindas aqui";
    if (t === "delay") payload = 2;
    if (t === "send_media") payload = "data:...base64,...";
    if (t === "handover_human") payload = null;
    if (t === "update_crm") payload = { stage: "", tag: "", note: "" };
    if (t === "call_webhook") payload = { url: "", headers: {}, timeout_ms: 8000 };
    actions.push({ type: t, payload });
    renderModalActions();
  };

  btnSave.onclick = async () => {
    const name = nameInput.value.trim() || "Boas-vindas";
    const payload = { name, actions, active: activeInput.checked };
    try {
      await saveFlow(payload);
      welcome = { ...welcome, ...payload };
      closeModal();
      renderCard();
    } catch (err) {
      alert("Erro ao salvar fluxo de boas-vindas");
    }
  };

  btnCancel.onclick = closeModal;

  btnEdit.onclick = openModal;

  btnToggle.onclick = async () => {
    try {
      const next = !welcome.active;
      const payloadActions = actions.length ? actions : welcome.actions;
      await saveFlow({ name: welcome.name || "Boas-vindas", actions: payloadActions, active: next });
      welcome.actions = payloadActions;
      welcome.active = next;
      renderCard();
    } catch (err) {
      alert("Erro ao alternar fluxo de boas-vindas");
    }
  };

  btnTest.onclick = async () => {
    const msg = prompt("Mensagem de teste (simula primeira mensagem do cliente):", "Olá!");
    if (msg === null) return;
    try {
      const res = await fetch("/api/welcome-flow/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      if (!data.ok) return alert("Falha ao simular fluxo");
      alert((data.logs || []).join("\n") || "Fluxo executaria sem ações visíveis.");
    } catch (err) {
      alert("Erro ao simular fluxo");
    }
  };

  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  // init
  fetchFlow();
})();
