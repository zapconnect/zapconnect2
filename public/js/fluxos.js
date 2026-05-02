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

  if (!flowsWrap || !modal || !flowName || !flowTrigger || !flowActions) {
    return;
  }

  const flowEditor = window.FlowNodeEditor.create({
    listEl: flowActions,
    addTypeEl: addActionType,
    addButtonEl: btnAddAction,
    emptyStateText: "Adicione o primeiro nó para montar a automação.",
  });

  let flows = [];
  let editing = null;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeParseJson(value, fallback) {
    try {
      const parsed = JSON.parse(value || "");
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function getFlowTriggers(flow) {
    const triggers = safeParseJson(flow?.triggers, null);
    if (Array.isArray(triggers) && triggers.length) {
      return triggers.map((item) => String(item ?? "").trim()).filter(Boolean);
    }

    const legacy = String(flow?.trigger || flow?.trigger_type || "").trim();
    return legacy ? [legacy] : [];
  }

  function getFlowActions(flow) {
    const actions = safeParseJson(flow?.actions, []);
    return Array.isArray(actions) ? actions : [];
  }

  function renderActionSummary(actions) {
    if (!Array.isArray(actions) || !actions.length) {
      return `<div class="flow-summary-empty">Nenhuma ação configurada.</div>`;
    }

    return actions
      .slice(0, 3)
      .map((action, index) => {
        const preview = window.FlowNodeEditor.previewAction(action);
        return `
          <div class="flow-summary-chip">
            <span class="flow-summary-index">${index + 1}</span>
            <div class="flow-summary-copy">${escapeHtml(preview)}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderFlows() {
    flowsWrap.innerHTML = "";

    if (!flows.length) {
      flowsWrap.innerHTML = `
        <div class="flow-card">
          <div class="flow-summary-empty">Você ainda não criou nenhum fluxo por gatilho.</div>
        </div>
      `;
      return;
    }

    flows.forEach((flow) => {
      const triggers = getFlowTriggers(flow);
      const actions = getFlowActions(flow);
      const card = document.createElement("article");
      card.className = "flow-card";
      card.innerHTML = `
        <div class="flow-card-meta">
          <div>
            <h3 class="flow-card-title">${escapeHtml(flow.name)}</h3>
            <p class="flow-trigger">
              Gatilhos: ${escapeHtml(triggers.length ? triggers.join(", ") : "Sem gatilho cadastrado")}
            </p>
          </div>
          <span class="flow-badge ${flow.active ? "is-active" : "is-paused"}">
            ${flow.active ? "Ativo" : "Pausado"}
          </span>
        </div>

        <div class="flow-summary">${renderActionSummary(actions)}</div>

        <div class="flow-card-actions">
          <button type="button" class="btn btn-secondary" data-action="edit" data-id="${flow.id}">Editar</button>
          <button type="button" class="btn btn-secondary" data-action="toggle" data-id="${flow.id}">
            ${flow.active ? "Pausar" : "Ativar"}
          </button>
          <button type="button" class="btn btn-ghost" data-action="test" data-id="${flow.id}">Simular</button>
          <button type="button" class="btn btn-ghost" data-action="delete" data-id="${flow.id}">Excluir</button>
        </div>
      `;
      flowsWrap.appendChild(card);
    });

    flowsWrap.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = Number(button.dataset.id);
        const action = button.dataset.action;

        if (!id || !action) return;

        if (action === "edit") openEdit(id);
        if (action === "toggle") toggleFlow(id);
        if (action === "test") testFlow(id);
        if (action === "delete") delFlow(id);
      });
    });
  }

  async function fetchList() {
    const response = await fetch("/api/flows/list");
    const data = await response.json();

    if (data.ok) {
      flows = Array.isArray(data.flows) ? data.flows : [];
      renderFlows();
    }
  }

  function openNew() {
    editing = null;
    modalTitle.innerText = "Novo fluxo";
    flowName.value = "";
    flowTrigger.value = "";
    if (flowActive) flowActive.checked = true;
    flowEditor.setActions([]);
    modal.style.display = "flex";
  }

  function openEdit(id) {
    const flow = flows.find((item) => item.id === id);
    if (!flow) return;

    editing = flow;
    modalTitle.innerText = "Editar fluxo";
    flowName.value = flow.name || "";
    flowTrigger.value = getFlowTriggers(flow)[0] || "";
    if (flowActive) flowActive.checked = flow.active !== 0;
    flowEditor.setActions(getFlowActions(flow));
    modal.style.display = "flex";
  }

  function closeModal() {
    modal.style.display = "none";
    clearAllFieldErrors?.(document);
  }

  async function saveFlow() {
    clearAllFieldErrors?.(document);

    const name = flowName.value.trim();
    const trigger = flowTrigger.value.trim();
    const actions = flowEditor.getActions();

    if (!name || !trigger) {
      if (!name) showFieldError?.(flowName, "Nome obrigatório.");
      if (!trigger) showFieldError?.(flowTrigger, "Trigger obrigatório.");
      return;
    }

    if (!actions.length) {
      alert("Adicione pelo menos um nó antes de salvar o fluxo.");
      return;
    }

    const active = flowActive ? flowActive.checked : true;
    const payload = { name, trigger, actions, active };

    setButtonLoading?.(btnSave, true, editing ? "Salvando..." : "Criando...");

    try {
      const response = await fetch(editing ? "/api/flows/update" : "/api/flows/create", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...payload } : payload),
      });
      const data = await response.json().catch(() => ({ ok: response.ok }));

      if (!response.ok || data.ok === false) {
        throw new Error(data.error || "Não foi possível salvar o fluxo.");
      }

      await fetchList();
      closeModal();
    } catch (error) {
      alert(error?.message || "Erro ao salvar o fluxo.");
    } finally {
      setButtonLoading?.(btnSave, false);
    }
  }

  async function delFlow(id) {
    if (!confirm("Deletar este fluxo?")) return;

    const response = await fetch("/api/flows/delete", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    if (!response.ok) {
      alert("Não foi possível excluir o fluxo.");
      return;
    }

    await fetchList();
  }

  async function toggleFlow(id) {
    const flow = flows.find((item) => item.id === id);
    if (!flow) return;

    const next = flow.active ? 0 : 1;
    const response = await fetch("/api/flows/active", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, active: next }),
    });

    if (!response.ok) {
      alert("Não foi possível atualizar o status do fluxo.");
      return;
    }

    await fetchList();
  }

  async function testFlow(id) {
    const message = prompt("Digite a mensagem de teste:");
    if (!message) return;

    try {
      const response = await fetch("/api/flows/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, message }),
      });
      const data = await response.json();

      if (!data.ok) {
        alert("Falha ao testar o fluxo.");
        return;
      }

      if (!data.matched) {
        alert("Nenhum trigger combinou com a mensagem.");
        return;
      }

      if (!data.conditionPassed) {
        alert("Os triggers combinaram, mas as condições do fluxo falharam.");
        return;
      }

      const logs = Array.isArray(data.logs) ? data.logs.join("\n") : "";
      alert(`Fluxo executaria:\n${logs || "(sem ações visíveis)"}`);
    } catch {
      alert("Erro ao testar o fluxo.");
    }
  }

  btnNew?.addEventListener("click", openNew);
  btnCancel?.addEventListener("click", closeModal);
  btnSave?.addEventListener("click", saveFlow);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  await fetchList();
})();
