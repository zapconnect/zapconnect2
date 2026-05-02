(() => {
  const TYPE_META = {
    send_text: { label: "Enviar texto", badge: "Enviar texto" },
    delay: { label: "Aguardar", badge: "Aguardar" },
    send_media: { label: "Enviar mídia", badge: "Enviar mídia" },
    handover_human: { label: "Humano", badge: "Encaminhar" },
    update_crm: { label: "Atualizar CRM", badge: "Atualizar CRM" },
    call_webhook: { label: "Webhook", badge: "Webhook" },
    condition: { label: "Condição", badge: "Condição" },
    branch: { label: "Condição antiga", badge: "Condição" },
  };

  let nextNodeId = 1;

  function clone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeHeaders(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value;
  }

  function normalizeConditionPayload(value) {
    const payload = value && typeof value === "object" ? value : {};
    return {
      field: ["crm_stage", "ia_message_count", "tag"].includes(payload.field)
        ? payload.field
        : "crm_stage",
      operator: payload.operator === "equals" ? "equals" : "equals",
      value: String(payload.value ?? "").trim(),
    };
  }

  function normalizeBranchCondition(value) {
    const payload = value && typeof value === "object" ? value : {};
    const raw = payload.contains;
    const contains = Array.isArray(raw)
      ? raw.map((item) => String(item ?? "").trim()).filter(Boolean)
      : String(raw ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);

    return contains.length ? { contains } : { contains: [] };
  }

  function getTypeMeta(type) {
    return TYPE_META[type] || { label: type, badge: type };
  }

  function createDefaultAction(type) {
    switch (type) {
      case "delay":
        return { type, payload: 2 };
      case "send_media":
        return { type, payload: "data:...base64,..." };
      case "handover_human":
        return { type, payload: null };
      case "update_crm":
        return { type, payload: { stage: "", tag: "", note: "" } };
      case "call_webhook":
        return { type, payload: { url: "", headers: {}, timeout_ms: 8000 } };
      case "condition":
        return {
          type,
          payload: { field: "crm_stage", operator: "equals", value: "" },
        };
      case "send_text":
      default:
        return { type: "send_text", payload: "Digite a mensagem aqui" };
    }
  }

  function normalizeAction(rawAction) {
    const base =
      rawAction && typeof rawAction === "object"
        ? clone(rawAction)
        : createDefaultAction("send_text");

    if (!base.type) {
      base.type = "send_text";
    }

    if (base.type === "delay") {
      const seconds = Number(base.payload);
      base.payload = Number.isFinite(seconds) && seconds > 0 ? seconds : 2;
    }

    if (base.type === "update_crm") {
      const payload = base.payload && typeof base.payload === "object" ? base.payload : {};
      base.payload = {
        stage: String(payload.stage ?? "").trim(),
        tag: String(payload.tag ?? "").trim(),
        note: String(payload.note ?? "").trim(),
      };
    }

    if (base.type === "call_webhook") {
      const payload = base.payload && typeof base.payload === "object" ? base.payload : {};
      base.payload = {
        url: String(payload.url ?? "").trim(),
        headers: normalizeHeaders(payload.headers),
        timeout_ms: Number(payload.timeout_ms) > 0 ? Number(payload.timeout_ms) : 8000,
      };
    }

    if (base.type === "condition") {
      base.payload = normalizeConditionPayload(base.payload || base.value || base.condition);
    }

    if (base.type === "branch") {
      base.condition = normalizeBranchCondition(base.condition || base.payload?.condition);
      base.then = Array.isArray(base.then)
        ? clone(base.then)
        : Array.isArray(base.true)
          ? clone(base.true)
          : Array.isArray(base.payload?.thenActions)
            ? clone(base.payload.thenActions)
            : [];
      base.else = Array.isArray(base.else)
        ? clone(base.else)
        : Array.isArray(base.false)
          ? clone(base.false)
          : Array.isArray(base.payload?.elseActions)
            ? clone(base.payload.elseActions)
            : [];
    }

    if (!Object.prototype.hasOwnProperty.call(base, "_nodeId")) {
      base._nodeId = `flow-node-${nextNodeId++}`;
    }

    return base;
  }

  function describeConditionField(field) {
    switch (field) {
      case "crm_stage":
        return "CRM stage";
      case "ia_message_count":
        return "Contagem de mensagens IA";
      case "tag":
        return "Tag do contato";
      default:
        return field;
    }
  }

  function previewAction(action) {
    if (!action) return "";

    if (action.type === "send_text") {
      return String(action.payload ?? "").trim() || "Mensagem vazia";
    }

    if (action.type === "delay") {
      return `Aguarda ${Number(action.payload) || 1} segundo(s) antes do próximo passo.`;
    }

    if (action.type === "send_media") {
      const value = String(action.payload ?? "").trim();
      return value ? `Envia mídia: ${value.slice(0, 90)}` : "Envia uma mídia configurada.";
    }

    if (action.type === "handover_human") {
      return "Entrega o atendimento para um operador humano.";
    }

    if (action.type === "update_crm") {
      const payload = action.payload || {};
      const parts = [];
      if (payload.stage) parts.push(`stage: ${payload.stage}`);
      if (payload.tag) parts.push(`tag: ${payload.tag}`);
      if (payload.note) parts.push(`nota: ${payload.note}`);
      return parts.length ? `Atualiza ${parts.join(" • ")}` : "Atualiza dados do CRM.";
    }

    if (action.type === "call_webhook") {
      const payload = action.payload || {};
      if (!payload.url) return "Dispara um webhook externo.";
      return `Chama ${payload.url}`;
    }

    if (action.type === "condition") {
      const payload = normalizeConditionPayload(action.payload || action.value || action.condition);
      const value = payload.value ? `"${payload.value}"` : "valor não definido";
      return `Se ${describeConditionField(payload.field)} = ${value}, o fluxo continua.`;
    }

    if (action.type === "branch") {
      const condition = normalizeBranchCondition(action.condition || action.payload?.condition);
      const keys = Array.isArray(condition.contains) ? condition.contains : [];
      const thenCount = Array.isArray(action.then) ? action.then.length : 0;
      const elseCount = Array.isArray(action.else) ? action.else.length : 0;
      const terms = keys.length ? keys.join(", ") : "palavras-chave";
      return `Ramo legado por mensagem (${terms}) • then: ${thenCount} • else: ${elseCount}`;
    }

    return `${getTypeMeta(action.type).label}`;
  }

  function renderPopover(action) {
    if (action.type === "send_text") {
      return `
        <label class="node-popover-field">
          <span>Mensagem</span>
          <textarea data-field="payload">${escapeHtml(String(action.payload ?? ""))}</textarea>
        </label>
      `;
    }

    if (action.type === "delay") {
      return `
        <label class="node-popover-field">
          <span>Segundos</span>
          <input data-field="payload" type="number" min="1" step="1" value="${escapeHtml(String(action.payload ?? 2))}">
        </label>
      `;
    }

    if (action.type === "send_media") {
      return `
        <label class="node-popover-field">
          <span>URL ou data URL</span>
          <textarea data-field="payload">${escapeHtml(String(action.payload ?? ""))}</textarea>
        </label>
      `;
    }

    if (action.type === "update_crm") {
      const payload = action.payload || {};
      return `
        <label class="node-popover-field">
          <span>Stage</span>
          <input data-field="stage" type="text" value="${escapeHtml(payload.stage || "")}" placeholder="Ex.: Qualificação">
        </label>
        <label class="node-popover-field">
          <span>Tag</span>
          <input data-field="tag" type="text" value="${escapeHtml(payload.tag || "")}" placeholder="Ex.: vip">
        </label>
        <label class="node-popover-field">
          <span>Nota</span>
          <textarea data-field="note">${escapeHtml(payload.note || "")}</textarea>
        </label>
      `;
    }

    if (action.type === "call_webhook") {
      const payload = action.payload || {};
      return `
        <label class="node-popover-field">
          <span>URL</span>
          <input data-field="url" type="url" value="${escapeHtml(payload.url || "")}" placeholder="https://...">
        </label>
        <label class="node-popover-field">
          <span>Timeout (ms)</span>
          <input data-field="timeout_ms" type="number" min="1000" step="500" value="${escapeHtml(String(payload.timeout_ms || 8000))}">
        </label>
        <label class="node-popover-field">
          <span>Headers (JSON)</span>
          <textarea data-field="headers">${escapeHtml(JSON.stringify(payload.headers || {}, null, 2))}</textarea>
        </label>
      `;
    }

    if (action.type === "condition") {
      const payload = normalizeConditionPayload(action.payload || action.value || action.condition);
      return `
        <label class="node-popover-field">
          <span>Campo</span>
          <select data-field="field">
            <option value="crm_stage" ${payload.field === "crm_stage" ? "selected" : ""}>CRM stage</option>
            <option value="tag" ${payload.field === "tag" ? "selected" : ""}>Tag do contato</option>
            <option value="ia_message_count" ${payload.field === "ia_message_count" ? "selected" : ""}>Contagem de mensagens IA</option>
          </select>
        </label>
        <label class="node-popover-field">
          <span>Operador</span>
          <input type="text" value="equals" disabled>
        </label>
        <label class="node-popover-field">
          <span>Valor</span>
          <input data-field="value" type="text" value="${escapeHtml(payload.value || "")}" placeholder="Ex.: Novo">
        </label>
      `;
    }

    if (action.type === "branch") {
      const condition = normalizeBranchCondition(action.condition || action.payload?.condition);
      const terms = Array.isArray(condition.contains) ? condition.contains.join(", ") : "";
      return `
        <p class="node-popover-note">
          Este nó veio do editor antigo. Ele continua preservando os blocos then/else já salvos.
        </p>
        <label class="node-popover-field">
          <span>Palavras-chave da mensagem</span>
          <input data-field="contains" type="text" value="${escapeHtml(terms)}" placeholder="Ex.: preço, orçamento">
        </label>
      `;
    }

    return `
      <p class="node-popover-note">Este nó não possui campos adicionais para edição.</p>
    `;
  }

  function stripInternal(action) {
    const cleaned = clone(action);
    delete cleaned._nodeId;
    return cleaned;
  }

  function createEditor(options) {
    const listEl = options.listEl;
    const addTypeEl = options.addTypeEl;
    const addButtonEl = options.addButtonEl;
    const emptyStateText = options.emptyStateText || "Nenhuma ação configurada ainda.";
    const onChange = typeof options.onChange === "function" ? options.onChange : null;

    const state = {
      actions: [],
      editingNodeId: null,
      draggedNodeId: null,
      dragTargetId: null,
      dragPosition: "after",
    };

    if (!listEl) {
      throw new Error("FlowNodeEditor precisa de um listEl.");
    }

    function getOrderedActions() {
      const domNodeIds = Array.from(listEl.querySelectorAll(".flow-node[data-node-id]"))
        .map((node) => node.dataset.nodeId)
        .filter(Boolean);

      if (!domNodeIds.length) {
        return state.actions.slice();
      }

      return domNodeIds
        .map((nodeId) => state.actions.find((action) => action._nodeId === nodeId))
        .filter(Boolean);
    }

    function syncStateWithDom() {
      state.actions = getOrderedActions();
    }

    function emitChange() {
      if (onChange) {
        onChange(api.getActions());
      }
    }

    function resetDragState() {
      state.dragTargetId = null;
      state.dragPosition = "after";
      listEl.querySelectorAll(".flow-node.drag-over").forEach((node) => {
        node.classList.remove("drag-over");
        delete node.dataset.dragPosition;
      });
      listEl.querySelectorAll(".flow-node.is-dragging").forEach((node) => {
        node.classList.remove("is-dragging");
      });
    }

    function render() {
      const actions = state.actions.slice();

      if (!actions.length) {
        listEl.innerHTML = `<div class="node-empty">${escapeHtml(emptyStateText)}</div>`;
        return;
      }

      listEl.innerHTML = actions
        .map((action, index) => {
          const meta = getTypeMeta(action.type);
          const isEditing = state.editingNodeId === action._nodeId;
          return `
            <div class="flow-node-stack">
              <div
                class="flow-node ${isEditing ? "is-editing" : ""}"
                draggable="true"
                data-index="${index}"
                data-node-id="${escapeHtml(action._nodeId)}"
                data-type="${escapeHtml(action.type)}"
              >
                <div class="node-header">
                  <span class="node-type-badge">${escapeHtml(meta.badge)}</span>
                  <div class="node-actions">
                    <button type="button" class="node-action-btn node-edit-btn" data-node-id="${escapeHtml(action._nodeId)}">Editar</button>
                    <button type="button" class="node-action-btn node-delete-btn" data-node-id="${escapeHtml(action._nodeId)}">×</button>
                  </div>
                </div>
                <div class="node-content">${escapeHtml(previewAction(action))}</div>
                ${
                  isEditing
                    ? `
                      <div class="node-popover" data-node-id="${escapeHtml(action._nodeId)}">
                        ${renderPopover(action)}
                        <div class="node-popover-actions">
                          <button type="button" class="node-popover-btn node-popover-cancel">Cancelar</button>
                          <button type="button" class="node-popover-btn node-popover-save">OK</button>
                        </div>
                      </div>
                    `
                    : ""
                }
              </div>
              ${index < actions.length - 1 ? '<div class="node-connector"></div>' : ""}
            </div>
          `;
        })
        .join("");
    }

    function findAction(nodeId) {
      return state.actions.find((action) => action._nodeId === nodeId) || null;
    }

    function updateActionFromPopover(nodeId, popoverEl) {
      const action = findAction(nodeId);
      if (!action || !popoverEl) return false;

      if (action.type === "send_text" || action.type === "send_media") {
        const field = popoverEl.querySelector('[data-field="payload"]');
        action.payload = String(field?.value ?? "").trim();
        return true;
      }

      if (action.type === "delay") {
        const field = popoverEl.querySelector('[data-field="payload"]');
        const seconds = Number(field?.value);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          alert("Informe um número de segundos válido.");
          return false;
        }
        action.payload = seconds;
        return true;
      }

      if (action.type === "update_crm") {
        action.payload = {
          stage: String(popoverEl.querySelector('[data-field="stage"]')?.value ?? "").trim(),
          tag: String(popoverEl.querySelector('[data-field="tag"]')?.value ?? "").trim(),
          note: String(popoverEl.querySelector('[data-field="note"]')?.value ?? "").trim(),
        };
        return true;
      }

      if (action.type === "call_webhook") {
        const headersInput = String(
          popoverEl.querySelector('[data-field="headers"]')?.value ?? "{}"
        ).trim();
        let headers = {};
        try {
          headers = headersInput ? JSON.parse(headersInput) : {};
        } catch {
          alert("Os headers do webhook precisam ser um JSON válido.");
          return false;
        }

        action.payload = {
          url: String(popoverEl.querySelector('[data-field="url"]')?.value ?? "").trim(),
          timeout_ms:
            Number(popoverEl.querySelector('[data-field="timeout_ms"]')?.value) > 0
              ? Number(popoverEl.querySelector('[data-field="timeout_ms"]')?.value)
              : 8000,
          headers: normalizeHeaders(headers),
        };
        return true;
      }

      if (action.type === "condition") {
        action.payload = normalizeConditionPayload({
          field: popoverEl.querySelector('[data-field="field"]')?.value,
          operator: "equals",
          value: String(popoverEl.querySelector('[data-field="value"]')?.value ?? "").trim(),
        });
        return true;
      }

      if (action.type === "branch") {
        action.condition = normalizeBranchCondition({
          contains: String(popoverEl.querySelector('[data-field="contains"]')?.value ?? ""),
        });
        return true;
      }

      return true;
    }

    function moveAction(sourceNodeId, targetNodeId, position) {
      const ordered = getOrderedActions();
      const sourceIndex = ordered.findIndex((action) => action._nodeId === sourceNodeId);
      const targetIndex = ordered.findIndex((action) => action._nodeId === targetNodeId);

      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return;
      }

      const [moved] = ordered.splice(sourceIndex, 1);
      let insertAt = targetIndex;

      if (position === "after") {
        insertAt = sourceIndex < targetIndex ? targetIndex : targetIndex + 1;
      } else {
        insertAt = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      }

      if (insertAt < 0) insertAt = 0;
      if (insertAt > ordered.length) insertAt = ordered.length;

      ordered.splice(insertAt, 0, moved);
      state.actions = ordered;
    }

    function handleAddAction() {
      const type = addTypeEl?.value || "send_text";
      const action = normalizeAction(createDefaultAction(type));
      state.actions.push(action);
      state.editingNodeId = action._nodeId;
      render();
      emitChange();
    }

    listEl.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;

      const flowNode = event.target.closest(".flow-node");
      const nodeId = flowNode?.dataset.nodeId || button.dataset.nodeId || null;

      if (button.classList.contains("node-delete-btn") && nodeId) {
        state.actions = state.actions.filter((action) => action._nodeId !== nodeId);
        if (state.editingNodeId === nodeId) {
          state.editingNodeId = null;
        }
        render();
        emitChange();
        return;
      }

      if (button.classList.contains("node-edit-btn") && nodeId) {
        state.editingNodeId = state.editingNodeId === nodeId ? null : nodeId;
        render();
        return;
      }

      if (button.classList.contains("node-popover-cancel")) {
        state.editingNodeId = null;
        render();
        return;
      }

      if (button.classList.contains("node-popover-save") && nodeId) {
        const popoverEl = flowNode?.querySelector(".node-popover");
        if (!updateActionFromPopover(nodeId, popoverEl)) {
          return;
        }
        state.editingNodeId = null;
        render();
        emitChange();
      }
    });

    listEl.addEventListener("dragstart", (event) => {
      const node = event.target.closest(".flow-node");
      if (!node) return;

      state.draggedNodeId = node.dataset.nodeId;
      state.dragTargetId = null;
      node.classList.add("is-dragging");

      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", state.draggedNodeId || "");
      }
    });

    listEl.addEventListener("dragover", (event) => {
      if (!state.draggedNodeId) return;
      event.preventDefault();

      const node = event.target.closest(".flow-node");
      resetDragState();

      if (!node || node.dataset.nodeId === state.draggedNodeId) return;

      const rect = node.getBoundingClientRect();
      const position = event.clientY < rect.top + rect.height / 2 ? "before" : "after";

      state.dragTargetId = node.dataset.nodeId;
      state.dragPosition = position;
      node.classList.add("drag-over");
      node.dataset.dragPosition = position;
    });

    listEl.addEventListener("drop", (event) => {
      if (!state.draggedNodeId || !state.dragTargetId) {
        resetDragState();
        state.draggedNodeId = null;
        return;
      }

      event.preventDefault();
      moveAction(state.draggedNodeId, state.dragTargetId, state.dragPosition);
      syncStateWithDom();
      state.draggedNodeId = null;
      resetDragState();
      render();
      emitChange();
    });

    listEl.addEventListener("dragend", () => {
      state.draggedNodeId = null;
      resetDragState();
      render();
    });

    if (addButtonEl) {
      addButtonEl.addEventListener("click", handleAddAction);
    }

    const api = {
      setActions(nextActions) {
        state.actions = Array.isArray(nextActions) ? nextActions.map(normalizeAction) : [];
        state.editingNodeId = null;
        state.draggedNodeId = null;
        render();
      },
      getActions() {
        syncStateWithDom();
        return state.actions.map(stripInternal);
      },
      clear() {
        state.actions = [];
        state.editingNodeId = null;
        render();
      },
    };

    render();
    return api;
  }

  window.FlowNodeEditor = {
    create: createEditor,
    previewAction,
  };
})();
