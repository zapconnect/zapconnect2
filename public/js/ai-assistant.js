(() => {
  const refs = {
    scope: document.getElementById("assistant-scope"),
    scopeHint: document.getElementById("assistant-scope-hint"),
    linkedAgentNote: document.getElementById("assistant-linked-agent-note"),
    modeButtons: [...document.querySelectorAll("[data-assistant-mode]")],
    form: document.getElementById("assistant-request-form"),
    instruction: document.getElementById("assistant-instruction"),
    generate: document.getElementById("assistant-generate"),
    status: document.getElementById("assistant-status"),
    draftPanel: document.getElementById("assistant-draft-panel"),
    draftFields: document.getElementById("assistant-draft-fields"),
    save: document.getElementById("assistant-save"),
    saveStatus: document.getElementById("assistant-save-status")
  };

  const fieldGroups = [
    { label: "Identidade", fields: [["assistantName", "Nome da IA"], ["companyName", "Nome da empresa"], ["role", "Função da IA"], ["personalityTone", "Personalidade e tom de voz"]] },
    { label: "Objetivo", fields: [["mainObjective", "Objetivo principal"]] },
    { label: "Conhecimento", fields: [["companyContext", "Sobre a empresa"], ["productsServices", "Produtos e serviços"], ["faq", "Perguntas frequentes"], ["additionalContext", "Contexto adicional"]] },
    { label: "Atendimento", fields: [["greeting", "Saudação"], ["serviceFlow", "Fluxo de atendimento"], ["leadQualification", "Qualificação de leads"]] },
    { label: "Vendas", fields: [["commercialRules", "Regras comerciais"], ["objections", "Tratamento de objeções"]] },
    { label: "Agendamento", fields: [["availability", "Disponibilidade"], ["bookingRules", "Regras de agendamento"], ["calendarInstructions", "Instruções de calendário"]] },
    { label: "Atendimento humano", fields: [["handoffConditions", "Quando transferir"], ["handoffMessage", "Mensagem de transferência"]] },
    { label: "Segurança", fields: [["restrictions", "Restrições"], ["closing", "Encerramento"], ["advancedInstructions", "Instruções adicionais"]] }
  ];

  const state = { currentConfig: null, linkedAgent: null, mode: "create" };

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: "include",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Não foi possível concluir a operação.");
    return data;
  }

  function setStatus(element, message, kind = "") {
    element.textContent = message;
    if (kind) element.dataset.state = kind;
    else delete element.dataset.state;
  }

  function currentSessionName() {
    return String(refs.scope.value || "").trim();
  }

  function setScopeHint(data) {
    const sessionName = currentSessionName();
    if (!sessionName) {
      refs.scopeHint.textContent = "A configuração geral é usada como padrão por todas as sessões.";
    } else if (data.inherited) {
      refs.scopeHint.textContent = `A sessão ${sessionName} herda atualmente a configuração geral. Ao salvar, você criará uma configuração exclusiva para ela.`;
    } else {
      refs.scopeHint.textContent = `Esta configuração vale somente para a sessão ${sessionName}.`;
    }

    refs.linkedAgentNote.hidden = !data.linkedAgent;
    if (data.linkedAgent) {
      refs.linkedAgentNote.textContent = `Esta sessão está vinculada ao agente “${data.linkedAgent.name}”, que tem prioridade nas respostas. A configuração desta tela ficará salva, mas só será usada quando o vínculo com esse agente for removido.`;
    }
  }

  async function loadCurrentConfig() {
    refs.draftPanel.hidden = true;
    refs.draftFields.replaceChildren();
    state.linkedAgent = null;
    setStatus(refs.status, "Carregando configuração…", "working");
    refs.scope.disabled = true;
    try {
      const sessionName = currentSessionName();
      const query = sessionName ? `?sessionName=${encodeURIComponent(sessionName)}` : "";
      const data = await requestJson(`/user/ai-config${query}`);
      state.currentConfig = data.config || {};
      state.linkedAgent = data.linkedAgent || null;
      setScopeHint(data);
      setStatus(refs.status, "Configuração carregada. Descreva o que quer criar ou ajustar.");
    } catch (error) {
      state.currentConfig = null;
      refs.linkedAgentNote.hidden = true;
      setStatus(refs.status, error.message || "Não foi possível carregar a configuração.", "error");
    } finally {
      refs.scope.disabled = false;
    }
  }

  function setMode(mode) {
    state.mode = mode === "adjust" ? "adjust" : "create";
    refs.modeButtons.forEach(button => {
      const active = button.dataset.assistantMode === state.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    refs.instruction.placeholder = state.mode === "adjust"
      ? "Ex.: Mantenha o restante como está, deixe o tom mais acolhedor e acrescente uma pergunta para entender o que o cliente procura."
      : "Ex.: Crie uma consultora para minha clínica, que acolha o paciente, tire dúvidas usando as informações cadastradas e ajude a agendar avaliações.";
  }

  function renderDraft(config) {
    refs.draftFields.replaceChildren();
    fieldGroups.forEach(group => {
      const section = document.createElement("section");
      section.className = "assistant-field-group";
      const heading = document.createElement("h3");
      heading.textContent = group.label;
      section.append(heading);
      group.fields.forEach(([key, labelText]) => {
        const field = document.createElement("div");
        field.className = "assistant-field";
        const label = document.createElement("label");
        const textarea = document.createElement("textarea");
        const id = `assistant-config-${key}`;
        label.htmlFor = id;
        label.textContent = labelText;
        textarea.id = id;
        textarea.dataset.configField = key;
        textarea.maxLength = 2000;
        textarea.rows = key === "assistantName" || key === "companyName" ? 2 : 3;
        textarea.value = String(config?.[key] || "");
        field.append(label, textarea);
        section.append(field);
      });
      refs.draftFields.append(section);
    });
  }

  function readDraft() {
    const config = { version: 1 };
    refs.draftFields.querySelectorAll("[data-config-field]").forEach(field => {
      config[field.dataset.configField] = field.value.trim();
    });
    return config;
  }

  async function generateDraft(event) {
    event.preventDefault();
    const instruction = refs.instruction.value.trim();
    if (!instruction) {
      setStatus(refs.status, "Descreva o atendimento que deseja configurar.", "error");
      refs.instruction.focus();
      return;
    }
    if (!state.currentConfig) {
      setStatus(refs.status, "A configuração ainda não foi carregada. Atualize a página e tente novamente.", "error");
      return;
    }

    refs.draftPanel.hidden = true;
    refs.draftFields.replaceChildren();
    refs.scope.disabled = true;
    refs.instruction.disabled = true;
    refs.modeButtons.forEach(button => { button.disabled = true; });
    refs.generate.disabled = true;
    refs.generate.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Preparando…';
    setStatus(refs.status, "O assistente está preparando uma proposta. Revise os campos antes de salvar.", "working");
    refs.save.disabled = true;
    try {
      const sessionName = currentSessionName();
      const data = await requestJson("/user/ai-config/assist", {
        method: "POST",
        body: JSON.stringify({
          instruction,
          mode: state.mode,
          config: state.currentConfig,
          ...(sessionName ? { sessionName } : {})
        })
      });
      renderDraft(data.config);
      refs.draftPanel.hidden = false;
      refs.draftPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus(refs.status, "Rascunho pronto. Revise e salve quando estiver satisfeito.", "success");
      setStatus(refs.saveStatus, "");
      refs.save.disabled = false;
    } catch (error) {
      setStatus(refs.status, error.message || "Não foi possível gerar o rascunho.", "error");
    } finally {
      refs.scope.disabled = false;
      refs.instruction.disabled = false;
      refs.modeButtons.forEach(button => { button.disabled = false; });
      refs.generate.disabled = false;
      refs.generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Gerar rascunho';
    }
  }

  async function saveDraft() {
    const config = readDraft();
    if (!Object.entries(config).some(([key, value]) => key !== "version" && value)) {
      setStatus(refs.saveStatus, "Preencha ao menos um campo antes de salvar.", "error");
      return;
    }
    refs.save.disabled = true;
    refs.scope.disabled = true;
    refs.instruction.disabled = true;
    refs.generate.disabled = true;
    refs.modeButtons.forEach(button => { button.disabled = true; });
    refs.draftFields.querySelectorAll("textarea").forEach(field => { field.disabled = true; });
    setStatus(refs.saveStatus, "Salvando configuração…", "working");
    try {
      const sessionName = currentSessionName();
      await requestJson("/user/ai-config", {
        method: "POST",
        body: JSON.stringify({ config, ...(sessionName ? { sessionName } : {}) })
      });
      state.currentConfig = config;
      setStatus(refs.saveStatus, "Configuração salva com sucesso.", "success");
      setStatus(
        refs.status,
        state.linkedAgent
          ? "Configuração salva. O agente vinculado continua prioritário enquanto permanecer associado à sessão."
          : "A configuração salva já está disponível para o atendimento.",
        "success"
      );
    } catch (error) {
      setStatus(refs.saveStatus, error.message || "Não foi possível salvar a configuração.", "error");
    } finally {
      refs.save.disabled = false;
      refs.scope.disabled = false;
      refs.instruction.disabled = false;
      refs.generate.disabled = false;
      refs.modeButtons.forEach(button => { button.disabled = false; });
      refs.draftFields.querySelectorAll("textarea").forEach(field => { field.disabled = false; });
    }
  }

  async function loadSessions() {
    try {
      const response = await fetch("/sessions/list", { credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível carregar as sessões.");
      (data.sessions || []).forEach(session => {
        const name = String(session.session_name || "").trim();
        if (!name) return;
        refs.scope.add(new Option(`${name}${session.status === "connected" ? " · Conectada" : ""}`, name));
      });
    } catch (error) {
      setStatus(refs.status, error.message || "Não foi possível carregar as sessões.", "error");
    }
  }

  refs.form.addEventListener("submit", generateDraft);
  refs.instruction.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      refs.form.requestSubmit();
    }
  });
  refs.save.addEventListener("click", saveDraft);
  refs.scope.addEventListener("change", loadCurrentConfig);
  refs.modeButtons.forEach(button => button.addEventListener("click", () => setMode(button.dataset.assistantMode)));

  setMode("create");
  loadSessions().then(loadCurrentConfig);
})();
