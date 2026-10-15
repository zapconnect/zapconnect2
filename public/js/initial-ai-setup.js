(() => {
  const start = () => {
    const modal = document.getElementById("initialAiSetup");
    if (!modal) return;

    const refs = {
      dialog: modal.querySelector(".initial-ai-setup-dialog"),
      chat: document.getElementById("initialSetupChat"),
      assistantMessage: document.getElementById("initialSetupAssistantMessage"),
      panels: [...modal.querySelectorAll("[data-setup-panel]")],
      progress: [...modal.querySelectorAll("[data-setup-progress]")],
      agentName: document.getElementById("initialSetupAgentName"),
      company: document.getElementById("initialSetupCompany"),
      business: document.getElementById("initialSetupBusiness"),
      goal: document.getElementById("initialSetupGoal"),
      tone: document.getElementById("initialSetupTone"),
      rules: document.getElementById("initialSetupRules"),
      handoff: document.getElementById("initialSetupHandoff"),
      session: document.getElementById("initialSetupSession"),
      status: document.getElementById("initialSetupStatus"),
      next: document.getElementById("initialSetupNext"),
      back: document.getElementById("initialSetupBack"),
      generate: document.getElementById("initialSetupGenerate"),
      save: document.getElementById("initialSetupSave"),
      generating: document.getElementById("initialSetupGenerating"),
      review: document.getElementById("initialSetupReview"),
      reviewFields: document.getElementById("initialSetupReviewFields"),
      actions: document.getElementById("initialSetupActions"),
      success: document.getElementById("initialSetupSuccess"),
      successMessage: document.getElementById("initialSetupSuccessMessage"),
    };

    const state = { step: 1, draft: null, busy: false, completed: false };
    const messages = {
      1: "Vamos começar pelo seu negócio. Conte o que a empresa oferece, quem atende e quais informações o agente pode compartilhar.",
      2: "Agora vamos definir como o agente atende e quando deve pedir ajuda à sua equipe.",
      3: "Aqui está a proposta criada a partir das suas respostas. Revise antes de salvar.",
    };
    const fieldLabels = {
      assistantName: "Nome do assistente",
      companyName: "Empresa",
      role: "Papel do agente",
      personalityTone: "Tom de voz",
      mainObjective: "Objetivo principal",
      companyContext: "Contexto da empresa",
      productsServices: "Produtos e serviços",
      faq: "Perguntas frequentes",
      additionalContext: "Informações adicionais",
      greeting: "Saudação",
      serviceFlow: "Fluxo de atendimento",
      leadQualification: "Qualificação de contatos",
      commercialRules: "Regras comerciais",
      objections: "Objeções",
      availability: "Disponibilidade",
      bookingRules: "Regras de agendamento",
      calendarInstructions: "Orientações de calendário",
      handoffConditions: "Quando chamar uma pessoa",
      handoffMessage: "Mensagem de transferência",
      restrictions: "Restrições",
      closing: "Encerramento",
      advancedInstructions: "Instruções adicionais",
    };

    document.body.classList.add("initial-ai-setup-open");

    function setStatus(message = "", kind = "") {
      refs.status.textContent = message;
      refs.status.classList.remove("is-error", "is-success");
      if (kind) refs.status.classList.add(`is-${kind}`);
    }

    function setStep(step) {
      state.step = step;
      refs.panels.forEach((panel) => {
        panel.hidden = Number(panel.dataset.setupPanel) !== step;
      });
      refs.progress.forEach((item) => {
        const itemStep = Number(item.dataset.setupProgress);
        item.classList.toggle("is-active", itemStep === step);
        item.classList.toggle("is-done", itemStep < step);
      });
      refs.assistantMessage.textContent = messages[step];
      refs.back.hidden = step === 1;
      refs.next.hidden = step !== 1;
      refs.generate.hidden = step !== 2;
      refs.save.hidden = step !== 3;
      refs.save.disabled = !state.draft || state.busy;
      refs.chat.hidden = false;
      refs.review.hidden = !state.draft || step !== 3;
      refs.generating.hidden = true;
      setStatus("");
    }

    async function requestJson(url, options = {}) {
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Não foi possível ler a resposta do servidor.");
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Não foi possível concluir essa etapa.");
      }
      return payload;
    }

    function validateStepOne() {
      const required = [
        [refs.agentName, "Informe um nome para o agente."],
        [refs.company, "Informe o nome da empresa."],
        [refs.business, "Conte o que a empresa oferece e quem atende."],
      ];
      for (const [element, message] of required) {
        if (!element.value.trim()) {
          setStatus(message, "error");
          element.focus();
          return false;
        }
      }
      if (refs.agentName.value.trim().length > 120) {
        setStatus("O nome do agente pode ter até 120 caracteres.", "error");
        refs.agentName.focus();
        return false;
      }
      return true;
    }

    function buildInstruction() {
      const sections = [
        `Crie um agente de atendimento para a empresa ${refs.company.value.trim()}.`,
        `Nome sugerido para o agente: ${refs.agentName.value.trim()}.`,
        `Sobre a empresa, seus produtos ou serviços e seu público: ${refs.business.value.trim()}.`,
        `Objetivo principal do atendimento: ${refs.goal.value}.`,
        `Tom de voz: ${refs.tone.value}.`,
      ];
      if (refs.rules.value.trim()) {
        sections.push(`Regras e limites informados pela empresa: ${refs.rules.value.trim()}.`);
      }
      if (refs.handoff.value.trim()) {
        sections.push(`Situações para encaminhar a uma pessoa: ${refs.handoff.value.trim()}.`);
      }
      sections.push("Não invente preços, prazos, horários, disponibilidade ou políticas que não foram informados.");
      return sections.join("\n");
    }

    function renderReview(config) {
      const fragment = document.createDocumentFragment();
      Object.entries(config || {}).forEach(([key, rawValue]) => {
        if (key === "version") return;
        const value = String(rawValue || "").trim();
        if (!value) return;

        const field = document.createElement("article");
        field.className = "initial-setup-review-field";
        const label = document.createElement("strong");
        label.textContent = fieldLabels[key] || key;
        const content = document.createElement("p");
        content.textContent = value;
        field.append(label, content);
        fragment.append(field);
      });
      refs.reviewFields.replaceChildren(fragment);
      refs.review.hidden = false;
      refs.save.disabled = false;
    }

    async function generateDraft() {
      if (!validateStepOne() || state.busy) return;
      const instruction = buildInstruction();
      if (instruction.length > 2500) {
        setStatus("Resuma um pouco as informações para continuar.", "error");
        return;
      }

      state.busy = true;
      state.draft = null;
      refs.generate.disabled = true;
      refs.generate.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Preparando…';
      setStep(3);
      refs.generating.hidden = false;
      refs.review.hidden = true;
      refs.save.disabled = true;
      setStatus("O assistente está organizando suas respostas. Isso pode levar alguns segundos.");
      try {
        const payload = await requestJson("/api/ai-agents/draft", {
          method: "POST",
          body: JSON.stringify({ name: refs.agentName.value.trim(), instruction }),
        });
        state.draft = payload.draft;
        renderReview(state.draft?.config);
        refs.generating.hidden = true;
        refs.assistantMessage.textContent = messages[3];
        setStatus("Proposta pronta. Confira as informações antes de salvar.", "success");
      } catch (error) {
        setStep(2);
        setStatus(error.message, "error");
      } finally {
        state.busy = false;
        refs.generate.disabled = false;
        refs.generate.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Montar proposta';
        refs.save.disabled = !state.draft;
      }
    }

    async function saveSetup() {
      if (!state.draft?.config || state.busy) return;
      state.busy = true;
      refs.save.disabled = true;
      refs.save.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Salvando…';
      setStatus("Salvando o perfil e aplicando a configuração…");
      try {
        const payload = await requestJson("/api/onboarding/assistant/complete", {
          method: "POST",
          body: JSON.stringify({
            name: refs.agentName.value.trim(),
            config: state.draft.config,
            sessionName: refs.session.value || null,
          }),
        });
        state.completed = true;
        if (typeof window.updateIaAutomationUi === "function") {
          window.updateIaAutomationUi(true);
        }
        refs.panels.forEach((panel) => { panel.hidden = true; });
        refs.progress.forEach((item) => { item.hidden = true; });
        refs.chat.hidden = true;
        refs.actions.hidden = true;
        refs.success.hidden = false;

        if (payload.sessionLinked) {
          refs.successMessage.textContent = `O agente foi salvo e vinculado à sessão ${refs.session.value}. A configuração também ficou como padrão da conta quando ainda não havia outra configuração.`;
        } else if (payload.appliedToAccount) {
          refs.successMessage.textContent = "O agente foi salvo e sua configuração ficou ativa como padrão da conta. Ao conectar o WhatsApp, você poderá começar a usar o atendimento.";
        } else {
          refs.successMessage.textContent = "O perfil foi salvo e a configuração já existente da conta foi preservada. Você pode ajustar a configuração padrão pelo Assistente IA.";
        }
        setStatus("Configuração salva.", "success");
      } catch (error) {
        setStatus(error.message, "error");
        if (error.message.includes("sessão")) {
          state.draft = null;
          setStep(2);
          setStatus(`${error.message} Confira a sessão selecionada e gere a proposta novamente.`, "error");
        }
      } finally {
        state.busy = false;
        refs.save.disabled = !state.draft;
        refs.save.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Salvar e ativar';
      }
    }

    async function dismissForLater() {
      if (state.completed) {
        modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("initial-ai-setup-open");
        modal.remove();
        return;
      }
      if (state.busy) return;
      state.busy = true;
      setStatus("Salvando sua escolha…");
      modal.querySelectorAll("[data-initial-setup-later]").forEach((button) => { button.disabled = true; });
      try {
        await requestJson("/api/onboarding/assistant/dismiss", { method: "POST", body: "{}" });
        modal.setAttribute("aria-hidden", "true");
        document.body.classList.remove("initial-ai-setup-open");
        modal.remove();
      } catch (error) {
        setStatus(error.message, "error");
        modal.querySelectorAll("[data-initial-setup-later]").forEach((button) => { button.disabled = false; });
      } finally {
        state.busy = false;
      }
    }

    refs.next.addEventListener("click", () => {
      if (!validateStepOne()) return;
      setStep(2);
    });
    refs.back.addEventListener("click", () => {
      if (state.step === 3) state.draft = null;
      setStep(Math.max(1, state.step - 1));
    });
    refs.generate.addEventListener("click", generateDraft);
    refs.save.addEventListener("click", saveSetup);
    modal.querySelectorAll("[data-initial-setup-later]").forEach((button) => {
      button.addEventListener("click", dismissForLater);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !state.completed && modal.getAttribute("aria-hidden") !== "true") {
        void dismissForLater();
      }
    });

    setStep(1);
    window.setTimeout(() => refs.agentName.focus(), 50);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
