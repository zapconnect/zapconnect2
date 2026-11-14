(function () {
  const bootstrap = window.__FOLLOW_UP_BOOTSTRAP__ || {};
  const refs = {
    status: document.getElementById("follow-up-status-pill"),
    save: document.getElementById("follow-up-save"),
    refresh: document.getElementById("follow-up-refresh"),
    tabs: Array.from(document.querySelectorAll(".follow-up-tab")),
    panels: Array.from(document.querySelectorAll(".follow-up-tab-panel")),
    scheduled: document.getElementById("follow-up-scheduled-list"),
    leads: document.getElementById("follow-up-leads-list"),
    results: document.getElementById("follow-up-results-list"),
    scheduledCount: document.getElementById("follow-up-scheduled-count"),
    leadsCount: document.getElementById("follow-up-leads-count"),
    steps: document.getElementById("follow-up-steps"),
    addStep: document.getElementById("follow-up-add-step"),
  };

  const state = {
    settings: normalizeSettings(bootstrap.settings),
    sessions: Array.isArray(bootstrap.sessions) ? bootstrap.sessions : [],
    activeTab: "configuration",
    busy: false,
  };

  function normalizeSettings(value) {
    const raw = value && typeof value === "object" ? value : {};
    const steps = Array.isArray(raw.warmSteps) && raw.warmSteps.length
      ? raw.warmSteps.slice(0, 5).map((step, index) => ({
          afterMinutes: Math.max(1, Number(step?.afterMinutes) || (index === 0 ? 60 : 1440)),
          writer: step?.writer === "manual" ? "manual" : "ai",
          message: String(step?.message || ""),
          instruction: String(step?.instruction || ""),
        }))
      : [{ afterMinutes: 60, writer: "ai", message: "", instruction: "" }];
    return {
      warmEnabled: Boolean(raw.warmEnabled),
      warmSteps: steps,
      stalledEnabled: Boolean(raw.stalledEnabled),
      stalledAfterDays: Number(raw.stalledAfterDays) || 7,
      dailyLimit: Number(raw.dailyLimit) || 20,
      repeatAfterDays: Number(raw.repeatAfterDays) || 30,
      maxRevisits: Number(raw.maxRevisits) || 3,
      sendStart: String(raw.sendStart || "08:00"),
      sendEnd: String(raw.sendEnd || "21:00"),
      preferredSession: String(raw.preferredSession || ""),
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function notify(type, message) {
    if (typeof window.showToast === "function") window.showToast(type, message);
    else if (type === "error") alert(message);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    let payload = {};
    try { payload = await response.json(); } catch { }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || "Não foi possível concluir a operação.");
    }
    return payload;
  }

  function renderSessionOptions() {
    const select = document.getElementById("preferred-session");
    if (!select) return;
    const connected = state.sessions.filter((session) => session.status === "connected");
    select.innerHTML = [
      '<option value="">Usar a sessão conectada mais recente</option>',
      ...connected.map((session) => `<option value="${escapeHtml(session.session_name)}">${escapeHtml(session.session_name)}</option>`),
    ].join("");
    select.value = state.settings.preferredSession;
  }

  function renderSteps() {
    refs.steps.innerHTML = state.settings.warmSteps.map((step, index) => `
      <article class="fu-step" data-step-index="${index}">
        <div class="fu-step-head">
          <div class="fu-step-number"><b>${index + 1}</b> ${index ? "Próxima mensagem" : "Primeira mensagem"}</div>
          ${state.settings.warmSteps.length > 1 ? `<button class="fu-link-button" type="button" data-remove-step="${index}" aria-label="Remover mensagem ${index + 1}"><i class="fa-solid fa-trash"></i></button>` : ""}
        </div>
        <div class="fu-step-grid">
          <label class="fu-field">
            <span>Enviar depois de</span>
            <div class="fu-input-suffix"><input type="number" min="1" max="43200" value="${Math.max(1, Number(step.afterMinutes) || 60)}" data-step-delay /><b>minutos</b></div>
          </label>
          <label class="fu-field">
            <span>Quem escreve</span>
            <select data-step-writer>
              <option value="ai" ${step.writer === "ai" ? "selected" : ""}>Pela IA</option>
              <option value="manual" ${step.writer === "manual" ? "selected" : ""}>Texto manual</option>
            </select>
          </label>
          ${step.writer === "ai"
            ? `<label class="fu-field fu-field-wide"><span>Orientação para a IA (opcional)</span><textarea maxlength="500" data-step-instruction placeholder="Ex.: retome a dúvida sobre o preço, sem insistir.">${escapeHtml(step.instruction)}</textarea></label>`
            : `<label class="fu-field fu-field-wide"><span>Texto da mensagem</span><textarea maxlength="2000" data-step-message placeholder="Oi {{nome}}, posso ajudar com mais alguma coisa?">${escapeHtml(step.message)}</textarea><small>Você pode usar {{nome}}, {{data}} e {{hora}}.</small></label>`}
        </div>
      </article>
    `).join("");

    refs.steps.querySelectorAll("[data-step-writer]").forEach((select) => {
      select.addEventListener("change", () => {
        state.settings.warmSteps = collectSteps();
        renderSteps();
      });
    });
    refs.steps.querySelectorAll("[data-remove-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.removeStep);
        state.settings.warmSteps.splice(index, 1);
        if (!state.settings.warmSteps.length) {
          state.settings.warmSteps.push({ afterMinutes: 60, writer: "ai", message: "", instruction: "" });
        }
        renderSteps();
      });
    });
  }

  function collectSteps() {
    return Array.from(refs.steps.querySelectorAll(".fu-step")).map((card, index) => {
      const current = state.settings.warmSteps[index] || {};
      const writer = card.querySelector("[data-step-writer]")?.value === "manual" ? "manual" : "ai";
      return {
        afterMinutes: Math.max(1, Number(card.querySelector("[data-step-delay]")?.value) || 60),
        writer,
        message: writer === "manual" ? String(card.querySelector("[data-step-message]")?.value || "").trim() : current.message || "",
        instruction: writer === "ai" ? String(card.querySelector("[data-step-instruction]")?.value || "").trim() : current.instruction || "",
      };
    });
  }

  function hydrateForm() {
    document.getElementById("warm-enabled").checked = state.settings.warmEnabled;
    document.getElementById("stalled-enabled").checked = state.settings.stalledEnabled;
    document.getElementById("stalled-days").value = state.settings.stalledAfterDays;
    document.getElementById("daily-limit").value = state.settings.dailyLimit;
    document.getElementById("repeat-days").value = state.settings.repeatAfterDays;
    document.getElementById("max-revisits").value = state.settings.maxRevisits;
    document.getElementById("send-start").value = state.settings.sendStart;
    document.getElementById("send-end").value = state.settings.sendEnd;
    renderSessionOptions();
    renderSteps();
    updateStatusPill();
  }

  function collectSettings() {
    state.settings = {
      ...state.settings,
      warmEnabled: document.getElementById("warm-enabled").checked,
      warmSteps: collectSteps(),
      stalledEnabled: document.getElementById("stalled-enabled").checked,
      stalledAfterDays: Math.max(1, Number(document.getElementById("stalled-days").value) || 7),
      dailyLimit: Math.max(1, Math.min(20, Number(document.getElementById("daily-limit").value) || 20)),
      repeatAfterDays: Math.max(1, Number(document.getElementById("repeat-days").value) || 30),
      maxRevisits: Math.max(1, Math.min(3, Number(document.getElementById("max-revisits").value) || 3)),
      sendStart: document.getElementById("send-start").value || "08:00",
      sendEnd: document.getElementById("send-end").value || "21:00",
      preferredSession: document.getElementById("preferred-session").value || "",
    };
    return state.settings;
  }

  function updateStatusPill() {
    const enabled = state.settings.warmEnabled || state.settings.stalledEnabled;
    refs.status.textContent = enabled ? "Automação ativa" : "Automações desligadas";
    refs.status.classList.toggle("is-active", enabled);
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.innerHTML;
      button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(label || "Aguarde")}`;
      button.disabled = true;
    } else {
      button.innerHTML = button.dataset.originalLabel || button.innerHTML;
      button.disabled = false;
      delete button.dataset.originalLabel;
    }
  }

  async function saveSettings() {
    const settings = collectSettings();
    if (settings.sendStart >= settings.sendEnd) {
      notify("error", "O fim da janela precisa ser depois do início.");
      return;
    }
    const button = refs.save;
    setBusy(button, true, "Salvando");
    try {
      const result = await api("/api/follow-up/settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
      state.settings = normalizeSettings(result.settings);
      hydrateForm();
      notify("success", "Configuração de Follow-up salva.");
      if (state.activeTab === "leads") await loadLeads();
    } catch (error) {
      notify("error", error.message);
    } finally {
      setBusy(button, false);
    }
  }

  function setActiveTab(name) {
    state.activeTab = name;
    refs.tabs.forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    refs.panels.forEach((panel) => {
      const active = panel.dataset.panel === name;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
    });
    if (name === "scheduled") loadItems("scheduled");
    if (name === "leads") loadLeads();
    if (name === "results") loadItems("results");
  }

  function emptyState(icon, title, copy) {
    return `<div class="fu-empty"><i class="${icon}"></i><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div>`;
  }

  function formatDate(timestamp) {
    if (!timestamp) return "Sem horário";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(Number(timestamp)));
  }

  function formatPhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits ? `+${digits}` : "Número não informado";
  }

  function itemKind(item) { return item.kind === "stalled" ? "Lead parado" : `Retomada · mensagem ${Number(item.stepIndex || 0) + 1}`; }

  function statusLabel(status) {
    const labels = {
      pending: ["Agendado", ""], processing: ["Enviando", "fu-chip-waiting"],
      awaiting_approval: ["Aguardando aprovação", "fu-chip-waiting"],
      sent: ["Enviado", "fu-chip-sent"], failed: ["Falhou", "fu-chip-failed"],
      cancelled: ["Cancelado", ""], skipped: ["Ignorado", ""],
    };
    return labels[status] || [status || "Pendente", ""];
  }

  function renderItem(item, results) {
    const [statusText, statusClass] = statusLabel(item.status);
    const initials = String(item.contactName || "L").trim().slice(0, 1).toUpperCase() || "L";
    const isDraft = item.status === "awaiting_approval";
    const when = item.status === "sent" ? formatDate(item.sentAt) : formatDate(item.dueAt);
    const error = item.lastError ? `<p class="fu-error-copy">${escapeHtml(item.lastError)}</p>` : "";
    return `
      <article class="fu-item-card" data-item-card="${Number(item.id)}">
        <div class="fu-item-top">
          <div class="fu-contact">
            <span class="fu-contact-avatar">${escapeHtml(initials)}</span>
            <div class="fu-contact-copy"><strong>${escapeHtml(item.contactName || "Lead")}</strong><small>${escapeHtml(formatPhone(item.contactPhone))} · ${escapeHtml(itemKind(item))}</small></div>
          </div>
          <div class="fu-item-meta"><span class="fu-chip ${statusClass}">${escapeHtml(statusText)}</span><span class="fu-chip"><i class="fa-regular fa-clock"></i> ${escapeHtml(when)}</span></div>
        </div>
        ${isDraft ? `<div class="fu-message-editor"><label for="fu-message-${Number(item.id)}">Rascunho da IA · revise antes de aprovar</label><textarea id="fu-message-${Number(item.id)}" maxlength="2000" data-item-message>${escapeHtml(item.draftMessage || "")}</textarea></div>` : ""}
        ${error}
        ${isDraft ? `<div class="fu-item-actions"><button class="btn btn-secondary" type="button" data-save-draft="${Number(item.id)}">Salvar edição</button><button class="btn btn-primary" type="button" data-approve="${Number(item.id)}"><i class="fa-solid fa-check"></i> Aprovar e agendar</button><button class="btn btn-danger" type="button" data-cancel="${Number(item.id)}">Descartar</button></div>` : !results && ["pending", "processing"].includes(item.status) ? `<div class="fu-item-actions"><button class="btn btn-danger" type="button" data-cancel="${Number(item.id)}">Cancelar envio</button></div>` : ""}
      </article>`;
  }

  async function loadItems(tab) {
    const target = tab === "results" ? refs.results : refs.scheduled;
    target.innerHTML = '<div class="fu-loading"><i class="fa-solid fa-spinner fa-spin"></i> Carregando…</div>';
    try {
      const result = await api(`/api/follow-up/items?tab=${encodeURIComponent(tab)}`);
      const items = Array.isArray(result.items) ? result.items : [];
      if (tab === "scheduled") refs.scheduledCount.textContent = items.filter((item) => ["pending", "processing", "awaiting_approval"].includes(item.status)).length;
      target.innerHTML = items.length
        ? items.map((item) => renderItem(item, tab === "results")).join("")
        : emptyState(tab === "results" ? "fa-solid fa-chart-line" : "fa-regular fa-calendar-check", tab === "results" ? "Ainda não há resultados" : "Nenhum envio agendado", tab === "results" ? "Os envios e cancelamentos aparecerão aqui." : "Quando houver uma conversa elegível, os follow-ups aparecerão nesta lista.");
      bindItemActions(target);
    } catch (error) {
      target.innerHTML = emptyState("fa-solid fa-triangle-exclamation", "Não foi possível carregar", error.message);
    }
  }

  async function loadLeads() {
    refs.leads.innerHTML = '<div class="fu-loading"><i class="fa-solid fa-spinner fa-spin"></i> Procurando leads elegíveis…</div>';
    try {
      const result = await api("/api/follow-up/leads");
      const leads = Array.isArray(result.leads) ? result.leads : [];
      refs.leadsCount.textContent = leads.length;
      if (!state.settings.stalledEnabled) {
        refs.leads.innerHTML = emptyState("fa-solid fa-toggle-off", "Reengajamento desligado", "Ative esta automação na aba Configuração para preparar mensagens para leads parados.");
        return;
      }
      refs.leads.innerHTML = leads.length ? leads.map((lead) => {
        const days = Math.max(0, Math.floor((Date.now() - Number(lead.lastSeenAt || 0)) / 86_400_000));
        const initials = String(lead.name || "L").trim().slice(0, 1).toUpperCase() || "L";
        const deal = Number(lead.dealValue || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
        return `<article class="fu-item-card fu-lead-card" data-lead-card="${Number(lead.crmId)}">
          <div>
            <div class="fu-contact"><span class="fu-contact-avatar">${escapeHtml(initials)}</span><div class="fu-contact-copy"><strong>${escapeHtml(lead.name)}</strong><small>${escapeHtml(formatPhone(lead.phone))} · ${escapeHtml(lead.stage)}</small></div></div>
            <div class="fu-lead-facts"><span><i class="fa-regular fa-clock"></i> Sem atividade há ${days} dias</span><span><i class="fa-solid fa-wallet"></i> ${escapeHtml(deal)}</span><span><i class="fa-solid fa-rotate"></i> ${Number(lead.sentCount || 0)}/${state.settings.maxRevisits} tentativas</span></div>
          </div>
          <div class="fu-item-actions"><button class="btn btn-primary" type="button" data-prepare-lead="${Number(lead.crmId)}"><i class="fa-solid fa-wand-magic-sparkles"></i> Preparar mensagem</button></div>
        </article>`;
      }).join("") : emptyState("fa-solid fa-mug-hot", "Tudo em dia", "Não há leads sem atividade que precisem de reengajamento agora.");
      refs.leads.querySelectorAll("[data-prepare-lead]").forEach((button) => {
        button.addEventListener("click", async () => {
          const crmId = Number(button.dataset.prepareLead);
          setBusy(button, true, "Preparando");
          try {
            await api(`/api/follow-up/leads/${crmId}/draft`, { method: "POST", body: JSON.stringify({}) });
            notify("success", "Rascunho preparado. Revise antes de aprovar.");
            setActiveTab("scheduled");
          } catch (error) {
            notify("error", error.message);
            setBusy(button, false);
          }
        });
      });
    } catch (error) {
      refs.leads.innerHTML = emptyState("fa-solid fa-triangle-exclamation", "Não foi possível carregar", error.message);
    }
  }

  function bindItemActions(container) {
    container.querySelectorAll("[data-save-draft]").forEach((button) => button.addEventListener("click", () => saveDraft(button)));
    container.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => approveDraft(button)));
    container.querySelectorAll("[data-cancel]").forEach((button) => button.addEventListener("click", () => cancelItem(button)));
  }

  async function saveDraft(button) {
    const id = Number(button.dataset.saveDraft);
    const card = button.closest("[data-item-card]");
    const message = card?.querySelector("[data-item-message]")?.value || "";
    setBusy(button, true, "Salvando");
    try {
      await api(`/api/follow-up/items/${id}/draft`, { method: "PUT", body: JSON.stringify({ message }) });
      notify("success", "Rascunho atualizado.");
      await loadItems("scheduled");
    } catch (error) { notify("error", error.message); setBusy(button, false); }
  }

  async function approveDraft(button) {
    const id = Number(button.dataset.approve);
    const card = button.closest("[data-item-card]");
    const message = card?.querySelector("[data-item-message]")?.value || "";
    setBusy(button, true, "Agendando");
    try {
      await api(`/api/follow-up/items/${id}/draft`, { method: "PUT", body: JSON.stringify({ message }) });
      await api(`/api/follow-up/items/${id}/approve`, { method: "POST", body: JSON.stringify({}) });
      notify("success", "Mensagem aprovada e adicionada à fila de envio.");
      await loadItems("scheduled");
    } catch (error) { notify("error", error.message); setBusy(button, false); }
  }

  async function cancelItem(button) {
    const id = Number(button.dataset.cancel);
    setBusy(button, true, "Cancelando");
    try {
      await api(`/api/follow-up/items/${id}`, { method: "DELETE" });
      notify("success", "Follow-up cancelado.");
      await loadItems("scheduled");
      if (state.activeTab === "leads") await loadLeads();
    } catch (error) { notify("error", error.message); setBusy(button, false); }
  }

  async function refresh() {
    try {
      const settingsResult = await api("/api/follow-up/settings");
      state.settings = normalizeSettings(settingsResult.settings);
      state.sessions = Array.isArray(settingsResult.sessions) ? settingsResult.sessions : [];
      hydrateForm();
      if (state.activeTab === "scheduled") await loadItems("scheduled");
      if (state.activeTab === "leads") await loadLeads();
      if (state.activeTab === "results") await loadItems("results");
    } catch (error) { notify("error", error.message); }
  }

  refs.tabs.forEach((tab) => tab.addEventListener("click", () => setActiveTab(tab.dataset.tab)));
  refs.save.addEventListener("click", saveSettings);
  refs.refresh.addEventListener("click", refresh);
  refs.addStep.addEventListener("click", () => {
    if (state.settings.warmSteps.length >= 5) return notify("error", "Você pode configurar até 5 mensagens por sequência.");
    state.settings.warmSteps = collectSteps();
    state.settings.warmSteps.push({ afterMinutes: 1_440, writer: "ai", message: "", instruction: "" });
    renderSteps();
  });
  document.querySelectorAll("[data-refresh-tab]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.refreshTab === "scheduled") loadItems("scheduled");
    if (button.dataset.refreshTab === "leads") loadLeads();
    if (button.dataset.refreshTab === "results") loadItems("results");
  }));
  ["warm-enabled", "stalled-enabled"].forEach((id) => document.getElementById(id).addEventListener("change", () => {
    state.settings.warmEnabled = document.getElementById("warm-enabled").checked;
    state.settings.stalledEnabled = document.getElementById("stalled-enabled").checked;
    updateStatusPill();
  }));

  hydrateForm();
  loadItems("scheduled");
  loadLeads();
})();
