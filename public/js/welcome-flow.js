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

  if (!statusEl || !listEl || !actionsWrap || !window.FlowNodeEditor) return;

  const welcomeEditor = window.FlowNodeEditor.create({
    listEl: actionsWrap,
    addTypeEl: addActionType,
    addButtonEl: btnAddAction,
    emptyStateText: "Monte a jornada do primeiro contato adicionando o primeiro nó.",
  });

  let welcome = { id: null, name: "Boas-vindas", actions: [], active: true };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderPreview() {
    statusEl.textContent = welcome.active
      ? "Ativado para novos contatos"
      : "Desativado";
    statusEl.style.color = welcome.active ? "#2ee6a6" : "#ff8fa0";

    const actions = Array.isArray(welcome.actions) ? welcome.actions : [];
    if (!actions.length) {
      listEl.innerHTML = `
        <div class="preview-item is-empty">
          <strong>Fluxo vazio</strong>
          <p>Nenhuma ação configurada ainda.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = actions
      .slice(0, 4)
      .map((action, index) => {
        const preview = window.FlowNodeEditor.previewAction(action);
        return `
          <div class="preview-item">
            <strong>Etapa ${index + 1}</strong>
            <p>${escapeHtml(preview)}</p>
          </div>
        `;
      })
      .join("");

    if (actions.length > 4) {
      listEl.insertAdjacentHTML(
        "beforeend",
        `
          <div class="preview-item">
            <strong>Etapas extras</strong>
            <p>+ ${actions.length - 4} ação(ões) configurada(s).</p>
          </div>
        `
      );
    }
  }

  async function fetchFlow() {
    try {
      const response = await fetch("/api/welcome-flow");
      const data = await response.json();

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

      renderPreview();
    } catch {
      statusEl.textContent = "Erro ao carregar";
      statusEl.style.color = "#ff8fa0";
    }
  }

  function openModal() {
    nameInput.value = welcome.name || "Boas-vindas";
    activeInput.checked = !!welcome.active;
    welcomeEditor.setActions(Array.isArray(welcome.actions) ? welcome.actions : []);
    modal.style.display = "flex";
  }

  function closeModal() {
    modal.style.display = "none";
  }

  async function saveFlow(payload) {
    const response = await fetch("/api/welcome-flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({ ok: response.ok }));

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Não foi possível salvar o fluxo.");
    }
  }

  btnSave?.addEventListener("click", async () => {
    const name = nameInput.value.trim() || "Boas-vindas";
    const actions = welcomeEditor.getActions();

    if (!actions.length) {
      alert("Adicione pelo menos um nó ao fluxo de boas-vindas.");
      return;
    }

    const payload = { name, actions, active: activeInput.checked };

    setButtonLoading?.(btnSave, true, "Salvando...");

    try {
      await saveFlow(payload);
      welcome = { ...welcome, ...payload };
      closeModal();
      renderPreview();
    } catch (error) {
      alert(error?.message || "Erro ao salvar fluxo de boas-vindas.");
    } finally {
      setButtonLoading?.(btnSave, false);
    }
  });

  btnCancel?.addEventListener("click", closeModal);
  btnEdit?.addEventListener("click", openModal);

  btnToggle?.addEventListener("click", async () => {
    try {
      const next = !welcome.active;
      const payloadActions = Array.isArray(welcome.actions) ? welcome.actions : [];
      await saveFlow({
        name: welcome.name || "Boas-vindas",
        actions: payloadActions,
        active: next,
      });
      welcome.active = next;
      renderPreview();
    } catch {
      alert("Erro ao alternar o fluxo de boas-vindas.");
    }
  });

  btnTest?.addEventListener("click", async () => {
    const message = prompt(
      "Mensagem de teste (simula a primeira mensagem do cliente):",
      "Olá!"
    );
    if (message === null) return;

    try {
      const response = await fetch("/api/welcome-flow/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await response.json();

      if (!data.ok) {
        alert("Falha ao simular o fluxo.");
        return;
      }

      alert((data.logs || []).join("\n") || "Fluxo executaria sem ações visíveis.");
    } catch {
      alert("Erro ao simular o fluxo.");
    }
  });

  modal?.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  fetchFlow();
})();
