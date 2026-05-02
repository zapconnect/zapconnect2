function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function notify(message, type = "info") {
  showToast(type === "warn" ? "warn" : type, message);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function clearDisparoFieldErrors() {
  if (typeof clearAllFieldErrors === "function") {
    clearAllFieldErrors(document);
  }
}

function setDisparoFieldError(fieldId, message) {
  if (typeof showFieldError === "function") {
    showFieldError(fieldId, message);
  }
}

let isSending = false;
let isPaused = false;
let cancelRequested = false;
let shownWarnings = new Set();
let currentStep = 1;
let stats = { sent: 0, failed: 0, skipped: 0, total: 0 };
let dispatchLog = [];
let startTime = null;
let progressStatus = "O painel aparece quando o disparo começar.";
let progressPhase = "idle";

const STEP_COUNT = 3;
const MAX_DISPATCH_LOG_LINES = 200;
const PREVIEW_EXAMPLE_NAME = "João Silva";
const PREVIEW_EXAMPLE_ORDER = "PED-2048";
const PREVIEW_SUPPORTED_KEYS = new Set([
  "numero",
  "number",
  "nome",
  "name",
  "pedido",
  "order",
  "data",
  "data_atual",
  "hoje",
  "hora",
  "horario",
  "time",
  "date",
]);
const PHONE_BR_PREFIX = getConfiguredDefaultDdi();
const PHONE_BR_MAX_LENGTH = PHONE_BR_PREFIX.length + 11;
const DEFAULT_PREVIEW_NUMBER = `${PHONE_BR_PREFIX}11999991234`;

const refs = {
  btnStart: document.getElementById("btnStart"),
  btnPause: document.getElementById("btnPause"),
  btnCancel: document.getElementById("btnCancel"),
  btnPrevStep: document.getElementById("btnPrevStep"),
  btnNextStep: document.getElementById("btnNextStep"),
  numbersInput: document.getElementById("numbers"),
  messageInput: document.getElementById("message"),
  fileInput: document.getElementById("file"),
  filePicker: document.getElementById("filePicker"),
  filePickerLabel: document.getElementById("filePickerLabel"),
  fileMeta: document.getElementById("fileMeta"),
  progressPanel: document.getElementById("progressPanel"),
  dispTitle: document.getElementById("dispTitle"),
  dispEta: document.getElementById("dispEta"),
  dispStatusBadge: document.getElementById("dispStatusBadge"),
  dispStatusText: document.getElementById("dispStatusText"),
  dispBar: document.getElementById("dispBar"),
  dispSent: document.getElementById("dispSent"),
  dispFailed: document.getElementById("dispFailed"),
  dispSkipped: document.getElementById("dispSkipped"),
  dispRemaining: document.getElementById("dispRemaining"),
  dispLog: document.getElementById("dispLog"),
  dispLogMeta: document.getElementById("dispLogMeta"),
  btnExportLog: document.getElementById("btnExportLog"),
  stepButtons: Array.from(document.querySelectorAll("[data-step-target]")),
  stepPanels: Array.from(document.querySelectorAll("[data-step-panel]")),
  metricTotalLines: document.getElementById("metricTotalLines"),
  metricValidLines: document.getElementById("metricValidLines"),
  metricInvalidLines: document.getElementById("metricInvalidLines"),
  invalidNumbersBox: document.getElementById("invalidNumbersBox"),
  invalidNumbersList: document.getElementById("invalidNumbersList"),
  previewContactLabel: document.getElementById("previewContactLabel"),
  previewContactsCount: document.getElementById("previewContactsCount"),
  previewBubble: document.getElementById("previewBubble"),
  previewHelp: document.getElementById("previewHelp"),
  confirmPreviewLabel: document.getElementById("confirmPreviewLabel"),
  confirmPreviewBubble: document.getElementById("confirmPreviewBubble"),
  confirmSelectedCount: document.getElementById("confirmSelectedCount"),
  confirmValidCount: document.getElementById("confirmValidCount"),
  confirmInvalidCount: document.getElementById("confirmInvalidCount"),
  confirmMediaState: document.getElementById("confirmMediaState"),
  confirmEta: document.getElementById("confirmEta"),
  confirmSession: document.getElementById("confirmSession"),
  confirmRiskState: document.getElementById("confirmRiskState"),
  confirmWarnings: document.getElementById("confirmWarnings"),
  summaryValidCount: document.getElementById("summaryValidCount"),
  summaryInvalidCount: document.getElementById("summaryInvalidCount"),
  summaryMessageState: document.getElementById("summaryMessageState"),
  summaryMediaState: document.getElementById("summaryMediaState"),
  summaryEta: document.getElementById("summaryEta"),
  sidebarStepTitle: document.getElementById("sidebarStepTitle"),
  sidebarStepHint: document.getElementById("sidebarStepHint"),
  heroStepSummary: document.getElementById("heroStepSummary"),
  heroContactsPill: document.getElementById("heroContactsPill"),
  heroMediaPill: document.getElementById("heroMediaPill"),
  riskCard: document.getElementById("riskCard"),
  riskCardTitle: document.getElementById("riskCardTitle"),
  riskCardText: document.getElementById("riskCardText"),
};

const DEFAULT_START_LABEL =
  refs.btnStart?.innerHTML ||
  `<i class="fa-solid fa-rocket"></i> Confirmar e iniciar disparo`;
const DEFAULT_NEXT_LABEL =
  refs.btnNextStep?.innerHTML ||
  `<i class="fa-solid fa-arrow-right"></i> Avançar para mensagem`;
const DEFAULT_PAUSE_LABEL =
  refs.btnPause?.innerHTML ||
  `<i class="fa-solid fa-circle-pause"></i> Pausar`;

const wizardState = {
  riskCheck: null,
  riskKey: "",
};

if (refs.btnStart && refs.btnPause && refs.btnCancel && refs.btnPrevStep && refs.btnNextStep) {
  refs.btnStart.addEventListener("click", startDisparo);
  refs.btnPause.addEventListener("click", togglePause);
  refs.btnCancel.addEventListener("click", cancelDisparo);
  refs.btnPrevStep.addEventListener("click", handlePrevStep);
  refs.btnNextStep.addEventListener("click", handleNextStep);
}

if (refs.btnExportLog) {
  refs.btnExportLog.addEventListener("click", exportLog);
}

if (refs.stepButtons.length) {
  refs.stepButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const target = Number(button.dataset.stepTarget || 0);
      await handleStepClick(target);
    });
  });
}

if (refs.messageInput) {
  refs.messageInput.addEventListener("input", handleDraftMutation);
}

if (refs.fileInput) {
  refs.fileInput.addEventListener("change", handleDraftMutation);
}

bindNumbersTextareaMask();
initializeWizard();

function initializeWizard() {
  syncFileUi();
  refreshWizardUi();
  syncWizardState();
  updateProgressUI();
}

function handleDraftMutation() {
  wizardState.riskCheck = null;
  wizardState.riskKey = "";
  syncFileUi();
  refreshWizardUi();
}

function collectDraftState() {
  const rawLines = String(refs.numbersInput?.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const digitsOnly = rawLines.map((line) => line.replace(/\D/g, ""));
  const validNumbers = digitsOnly.filter((value) => value.length >= 10 && value.length <= 15);
  const invalidNumbers = digitsOnly.filter(
    (value) => value.length > 0 && (value.length < 10 || value.length > 15)
  );

  const rawMessage = String(refs.messageInput?.value || "");
  const message = rawMessage.trim();
  const file = refs.fileInput?.files?.[0] || null;
  const placeholders = extractTemplateKeys(rawMessage);
  const previewContact = buildPreviewContact(validNumbers[0]);
  const previewText = renderTemplatePreview(rawMessage, previewContact);

  return {
    rawLines,
    digitsOnly,
    validNumbers,
    invalidNumbers,
    rawMessage,
    message,
    file,
    placeholders,
    previewContact,
    previewText: previewText || "Sua mensagem aparecerá aqui.",
    etaSeconds: validNumbers.length * 3,
  };
}

function buildPreviewContact(number) {
  const now = new Date();
  const date = now.toLocaleDateString("pt-BR");
  const time = now.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const displayNumber = formatPhoneDisplay(number || DEFAULT_PREVIEW_NUMBER);

  return {
    numero: displayNumber,
    number: displayNumber,
    nome: PREVIEW_EXAMPLE_NAME,
    name: PREVIEW_EXAMPLE_NAME,
    pedido: PREVIEW_EXAMPLE_ORDER,
    order: PREVIEW_EXAMPLE_ORDER,
    data: date,
    data_atual: date,
    hoje: date,
    hora: time,
    horario: time,
    time,
    date,
  };
}

function renderTemplatePreview(template, vars) {
  if (!template) return "";
  return String(template).replace(/{{\s*([\w.-]+)\s*}}/gi, (_match, rawKey) => {
    const key = String(rawKey || "").toLowerCase();
    return vars[key] !== undefined ? String(vars[key]) : "";
  });
}

function extractTemplateKeys(template) {
  const out = new Set();
  String(template || "").replace(/{{\s*([\w.-]+)\s*}}/gi, (_match, rawKey) => {
    out.add(String(rawKey || "").toLowerCase());
    return "";
  });
  return Array.from(out);
}

function buildTemplateWarnings(draft) {
  const warnings = [];
  const placeholderSet = new Set(draft.placeholders);
  const exampleOnlyKeys = ["nome", "name", "pedido", "order"].filter((key) =>
    placeholderSet.has(key)
  );
  const unsupported = draft.placeholders.filter((key) => !PREVIEW_SUPPORTED_KEYS.has(key));

  if (exampleOnlyKeys.length) {
    warnings.push(
      `O preview usa valores de exemplo para ${exampleOnlyKeys
        .map((key) => `{{${key}}}`)
        .join(", ")}.`
    );
  }

  if (unsupported.length) {
    warnings.push(
      `Campos como ${unsupported
        .slice(0, 3)
        .map((key) => `{{${key}}}`)
        .join(", ")} precisam de dados enriquecidos para funcionar no envio real.`
    );
  }

  return warnings;
}

function getPreviewLabel(draft) {
  if (draft.placeholders.includes("nome") || draft.placeholders.includes("name")) {
    return PREVIEW_EXAMPLE_NAME;
  }
  return draft.validNumbers.length
    ? formatPhoneDisplay(draft.validNumbers[0])
    : PREVIEW_EXAMPLE_NAME;
}

function refreshWizardUi() {
  const draft = collectDraftState();
  renderContactsMetrics(draft);
  renderPreviewCard(draft);
  renderConfirmSummary(draft, wizardState.riskCheck);
  renderSidebarSummary(draft);
}

function renderContactsMetrics(draft) {
  if (refs.metricTotalLines) refs.metricTotalLines.textContent = String(draft.rawLines.length);
  if (refs.metricValidLines) refs.metricValidLines.textContent = String(draft.validNumbers.length);
  if (refs.metricInvalidLines) refs.metricInvalidLines.textContent = String(draft.invalidNumbers.length);

  if (!refs.invalidNumbersBox || !refs.invalidNumbersList) return;

  if (!draft.invalidNumbers.length) {
    refs.invalidNumbersBox.hidden = true;
    refs.invalidNumbersList.innerHTML = "";
    return;
  }

  const visible = draft.invalidNumbers.slice(0, 12);
  const remaining = Math.max(draft.invalidNumbers.length - visible.length, 0);
  refs.invalidNumbersList.innerHTML = visible
    .map((value) => `<span class="pill-suspect">${escapeHtml(formatPhoneDisplay(value))}</span>`)
    .join("")
    .concat(
      remaining > 0
        ? `<span class="pill-suspect">+${remaining} outro(s)</span>`
        : ""
    );
  refs.invalidNumbersBox.hidden = false;
}

function renderPreviewCard(draft) {
  const previewLabel = getPreviewLabel(draft);
  const previewWarnings = buildTemplateWarnings(draft);

  if (refs.previewContactLabel) refs.previewContactLabel.textContent = previewLabel;
  if (refs.previewContactsCount) {
    refs.previewContactsCount.textContent = `${draft.validNumbers.length} contato(s) selecionado(s)`;
  }
  if (refs.previewBubble) refs.previewBubble.textContent = draft.previewText;
  if (refs.confirmPreviewLabel) refs.confirmPreviewLabel.textContent = previewLabel;
  if (refs.confirmPreviewBubble) refs.confirmPreviewBubble.textContent = draft.previewText;

  if (!refs.previewHelp) return;
  if (!draft.message && !draft.file) {
    refs.previewHelp.textContent = "Digite uma mensagem ou anexe mídia para liberar a revisão final.";
    return;
  }
  if (previewWarnings.length) {
    refs.previewHelp.textContent = previewWarnings[0];
    return;
  }
  refs.previewHelp.textContent = draft.file
    ? `Mídia anexada: ${draft.file.name}.`
    : "Avance quando o texto estiver pronto para revisão final.";
}

function renderSidebarSummary(draft) {
  if (refs.summaryValidCount) refs.summaryValidCount.textContent = String(draft.validNumbers.length);
  if (refs.summaryInvalidCount) refs.summaryInvalidCount.textContent = String(draft.invalidNumbers.length);
  if (refs.summaryMessageState) {
    refs.summaryMessageState.textContent = getMessageStateLabel(draft);
  }
  if (refs.summaryMediaState) {
    refs.summaryMediaState.textContent = draft.file ? draft.file.name : "Não anexada";
  }
  if (refs.summaryEta) refs.summaryEta.textContent = formatDurationLabel(draft.etaSeconds);
  if (refs.heroContactsPill) {
    refs.heroContactsPill.textContent = `${draft.validNumbers.length} contatos prontos`;
  }
  if (refs.heroMediaPill) {
    refs.heroMediaPill.textContent = draft.file ? `Mídia: ${draft.file.name}` : "Sem mídia anexada";
  }

  if (refs.sidebarStepTitle) refs.sidebarStepTitle.textContent = `Etapa ${currentStep}/${STEP_COUNT}`;
  if (refs.sidebarStepHint) refs.sidebarStepHint.textContent = getNextStepHint();
  if (refs.heroStepSummary) refs.heroStepSummary.textContent = getHeroStepSummary();
}

function renderConfirmSummary(draft, riskCheck) {
  if (refs.confirmSelectedCount) {
    refs.confirmSelectedCount.textContent = `${draft.validNumbers.length} contatos selecionados`;
  }
  if (refs.confirmValidCount) refs.confirmValidCount.textContent = String(draft.validNumbers.length);
  if (refs.confirmInvalidCount) refs.confirmInvalidCount.textContent = String(draft.invalidNumbers.length);
  if (refs.confirmMediaState) refs.confirmMediaState.textContent = draft.file ? draft.file.name : "Sem anexo";
  if (refs.confirmEta) refs.confirmEta.textContent = formatDurationLabel(draft.etaSeconds);

  const sessionLabel = riskCheck?.validationSession || riskCheck?.session || "A validar";
  if (refs.confirmSession) refs.confirmSession.textContent = sessionLabel;
  if (refs.confirmRiskState) refs.confirmRiskState.textContent = getRiskStateLabel(riskCheck);

  renderRiskCard(riskCheck, draft);
  renderConfirmWarnings(riskCheck, draft);
}

function renderRiskCard(riskCheck, draft) {
  if (!refs.riskCard || !refs.riskCardTitle || !refs.riskCardText) return;

  refs.riskCard.classList.remove("is-success", "is-warning", "is-danger");

  if (!riskCheck) {
    refs.riskCardTitle.textContent = "Aguardando revisão";
    refs.riskCardText.textContent =
      "Ao avançar para a etapa final, a sessão ativa e a qualidade da lista serão validadas.";
    return;
  }

  if (riskCheck.blocked || (!riskCheck.ok && !riskCheck.requiresConfirmation)) {
    refs.riskCard.classList.add("is-danger");
    refs.riskCardTitle.textContent = "Envio bloqueado";
    refs.riskCardText.textContent =
      riskCheck.error || "Não foi possível aprovar a campanha com a lista atual.";
    return;
  }

  if (riskCheck.requiresConfirmation) {
    refs.riskCard.classList.add("is-warning");
    refs.riskCardTitle.textContent = "Revisão adicional";
    refs.riskCardText.textContent =
      riskCheck.error ||
      `A campanha está pronta, mas o lote de ${draft.validNumbers.length} contatos exige confirmação final.`;
    return;
  }

  refs.riskCard.classList.add("is-success");
  refs.riskCardTitle.textContent = riskCheck.validationSession || riskCheck.session || "Lista validada";
  refs.riskCardText.textContent =
    riskCheck.listQuality?.recommendation ||
    `Campanha pronta para ${draft.validNumbers.length} contatos com intervalo estimado de ${formatDurationLabel(
      draft.etaSeconds
    )}.`;
}

function renderConfirmWarnings(riskCheck, draft) {
  if (!refs.confirmWarnings) return;

  const templateWarnings = buildTemplateWarnings(draft);
  const items = [];

  if (draft.invalidNumbers.length) {
    items.push({
      tone: "warning",
      text: `${draft.invalidNumbers.length} linha(s) fora do padrão serão ignoradas no envio.`,
    });
  }

  templateWarnings.forEach((text) => {
    items.push({ tone: "warning", text });
  });

  if (riskCheck?.requiresConfirmation) {
    items.push({
      tone: "warning",
      text:
        riskCheck.error ||
        `Ao confirmar, você autoriza um lote de ${draft.validNumbers.length} contatos nesta campanha.`,
    });
  }

  if (riskCheck?.blocked || (!riskCheck?.ok && !riskCheck?.requiresConfirmation)) {
    items.push({
      tone: "danger",
      text: riskCheck.error || "A validação impediu o disparo com a configuração atual.",
    });
  }

  const warnings = Array.isArray(riskCheck?.warnings) ? riskCheck.warnings : [];
  warnings.forEach((warning) => {
    items.push({ tone: "warning", text: warning });
  });

  if (!items.length) {
    refs.confirmWarnings.hidden = true;
    refs.confirmWarnings.innerHTML = "";
    return;
  }

  refs.confirmWarnings.innerHTML = items
    .map(
      (item) =>
        `<div class="confirm-alert ${item.tone === "danger" ? "is-danger" : "is-warning"}">${escapeHtml(
          item.text
        )}</div>`
    )
    .join("");
  refs.confirmWarnings.hidden = false;
}

function syncFileUi() {
  if (!refs.fileInput || !refs.filePicker || !refs.filePickerLabel || !refs.fileMeta) return;
  const file = refs.fileInput.files?.[0] || null;
  refs.filePicker.classList.toggle("has-file", Boolean(file));
  refs.filePickerLabel.textContent = file
    ? `Arquivo pronto: ${file.name}`
    : "Clique para anexar imagem, PDF, vídeo ou áudio";
  refs.fileMeta.textContent = file
    ? `${formatFileSize(file.size)} • O anexo será enviado junto da mensagem.`
    : "Nenhuma mídia anexada.";
}

function syncWizardState() {
  refs.stepButtons.forEach((button) => {
    const step = Number(button.dataset.stepTarget || 0);
    button.classList.toggle("is-active", step === currentStep);
    button.classList.toggle("is-done", step < currentStep);
    button.classList.toggle("is-idle", step > currentStep);
    button.disabled = isSending;
  });

  refs.stepPanels.forEach((panel) => {
    const panelStep = Number(panel.dataset.stepPanel || 0);
    panel.classList.toggle("is-active", panelStep === currentStep);
  });

  if (refs.btnPrevStep) {
    refs.btnPrevStep.hidden = currentStep === 1;
    refs.btnPrevStep.disabled = isSending || currentStep === 1;
  }

  if (refs.btnNextStep) {
    refs.btnNextStep.hidden = currentStep === STEP_COUNT;
    refs.btnNextStep.disabled = isSending;
    refs.btnNextStep.innerHTML =
      currentStep === 1
        ? `<i class="fa-solid fa-arrow-right"></i> Avançar para mensagem`
        : `<i class="fa-solid fa-arrow-right"></i> Avançar para confirmar`;
  }

  if (refs.btnStart) {
    refs.btnStart.hidden = currentStep !== STEP_COUNT;
    refs.btnStart.disabled = isSending;
  }

  if (refs.btnPause) refs.btnPause.disabled = !isSending;
  if (refs.btnCancel) refs.btnCancel.disabled = !isSending;

  refreshWizardUi();
}

function getHeroStepSummary() {
  if (currentStep === 1) return "Etapa 1/3 — comece pela lista de contatos.";
  if (currentStep === 2) return "Etapa 2/3 — revise a mensagem e o preview.";
  if (isSending) return "Etapa 3/3 — disparo em andamento.";
  return "Etapa 3/3 — confirme o resumo antes de enviar.";
}

function getNextStepHint() {
  if (currentStep === 1) return "Próximo: mensagem";
  if (currentStep === 2) return "Próximo: confirmar";
  return isSending ? "Execução em andamento" : "Próximo: iniciar disparo";
}

function getMessageStateLabel(draft) {
  if (draft.message) {
    return `${draft.message.length} caractere(s)`;
  }
  return draft.file ? "Somente mídia" : "Vazia";
}

function getRiskStateLabel(riskCheck) {
  if (!riskCheck) return "Pendente";
  if (riskCheck.blocked || (!riskCheck.ok && !riskCheck.requiresConfirmation)) {
    return "Bloqueado";
  }
  if (riskCheck.requiresConfirmation) return "Confirmação extra";
  return "Aprovado";
}

async function handleStepClick(targetStep) {
  if (isSending || !targetStep || targetStep === currentStep) return;

  if (targetStep < currentStep) {
    currentStep = targetStep;
    syncWizardState();
    return;
  }

  if (targetStep === currentStep + 1) {
    await handleNextStep();
  }
}

function handlePrevStep() {
  if (isSending || currentStep === 1) return;
  currentStep -= 1;
  syncWizardState();
}

async function handleNextStep() {
  if (isSending) return;

  if (currentStep === 1) {
    if (!validateContactsStep()) return;
    currentStep = 2;
    syncWizardState();
    return;
  }

  if (currentStep === 2) {
    const ready = await prepareConfirmStep();
    if (!ready) return;
    currentStep = 3;
    syncWizardState();
  }
}

function validateContactsStep() {
  clearDisparoFieldErrors();
  const draft = collectDraftState();

  if (!draft.validNumbers.length) {
    currentStep = 1;
    syncWizardState();
    setDisparoFieldError(
      "numbers",
      `Informe pelo menos um número válido com DDI ${PHONE_BR_PREFIX} e DDD.`
    );
    notify(`⚠️ Informe pelo menos um número válido com DDI ${PHONE_BR_PREFIX} e DDD.`, "error");
    return null;
  }

  if (draft.invalidNumbers.length) {
    notify(
      `⚠️ ${draft.invalidNumbers.length} número(s) fora do padrão serão ignorados na revisão final.`,
      "warn"
    );
  }

  return draft;
}

function validateMessageStep() {
  clearDisparoFieldErrors();
  const draft = collectDraftState();

  if (!draft.message && !draft.file) {
    currentStep = 2;
    syncWizardState();
    setDisparoFieldError("message", "Mensagem ou mídia obrigatória.");
    notify("⚠️ Mensagem ou mídia é obrigatória para continuar.", "error");
    return null;
  }

  return draft;
}

async function prepareConfirmStep() {
  const contactsDraft = validateContactsStep();
  if (!contactsDraft) return false;

  const draft = validateMessageStep();
  if (!draft) return false;

  const originalLabel = refs.btnNextStep?.innerHTML || DEFAULT_NEXT_LABEL;
  const riskKey = buildRiskKey(draft);

  if (wizardState.riskCheck && wizardState.riskKey === riskKey) {
    renderConfirmSummary(draft, wizardState.riskCheck);
    return true;
  }

  if (refs.btnNextStep) {
    refs.btnNextStep.disabled = true;
    refs.btnNextStep.classList.add("is-busy");
    refs.btnNextStep.innerHTML = `<i class="fa-solid fa-shield-check"></i> Validando sessão...`;
  }

  shownWarnings = new Set();
  const riskCheck = await runDisparoRiskCheck({
    numbers: draft.validNumbers,
    message: draft.message,
    confirmLargeBatch: false,
  });

  wizardState.riskCheck = riskCheck;
  wizardState.riskKey = riskKey;
  renderConfirmSummary(draft, riskCheck);

  if (refs.btnNextStep) {
    refs.btnNextStep.disabled = false;
    refs.btnNextStep.classList.remove("is-busy");
    refs.btnNextStep.innerHTML = originalLabel;
  }

  if (riskCheck.blocked || (!riskCheck.ok && !riskCheck.requiresConfirmation)) {
    notify(riskCheck.error || "Disparo bloqueado pela política de envio.", "error");
    return false;
  }

  return true;
}

async function waitWhilePausedOrCancelled() {
  while (isPaused) {
    setProgressStatus("⏸️ Disparo pausado");
    await sleep(300);
  }

  if (cancelRequested) {
    throw new Error("cancelled");
  }
}

async function controlledSleep(ms) {
  let elapsed = 0;
  const step = 300;

  while (elapsed < ms) {
    await waitWhilePausedOrCancelled();
    const chunk = Math.min(step, ms - elapsed);
    await sleep(chunk);
    elapsed += chunk;
  }
}

async function sendWithRetry(payload, maxRetries = 2) {
  let attempt = 0;
  let waitMs = 2000;

  while (attempt <= maxRetries) {
    try {
      await waitWhilePausedOrCancelled();

      const resp = await fetch("/api/disparo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));
      const warnings = Array.isArray(data?.warnings)
        ? data.warnings.filter((warning) => typeof warning === "string" && warning.trim())
        : [];
      notifyWarnings(warnings);

      if (resp.ok && !data.error) {
        return {
          ok: true,
          warnings,
          skipped: Number(data?.skipped || 0),
          paused: Boolean(data?.paused),
          stoppedReason: data?.stoppedReason || null,
        };
      }

      const error = new Error(data?.error || `Falha ao enviar (HTTP ${resp.status})`);
      error.retryable = data?.retryable !== false && resp.status >= 500;
      error.warnings = warnings;
      error.skipped = Number(data?.skipped || 0);
      error.paused = Boolean(data?.paused);
      error.requiresConfirmation = Boolean(data?.requiresConfirmation);
      throw error;
    } catch (error) {
      if (error?.retryable === false) {
        return {
          ok: false,
          error: error?.message || "Falha ao enviar.",
          warnings: Array.isArray(error?.warnings) ? error.warnings : [],
          skipped: Number(error?.skipped || 0),
          paused: Boolean(error?.paused),
          requiresConfirmation: Boolean(error?.requiresConfirmation),
        };
      }

      attempt += 1;
      if (attempt > maxRetries) break;

      notify(
        `⚠️ Falha no envio, tentando novamente em ${waitMs / 1000}s (tentativa ${attempt}/${maxRetries})...`,
        "warn"
      );
      await controlledSleep(waitMs);
      waitMs *= 2;
    }
  }

  return {
    ok: false,
    error: "Falha ao enviar após várias tentativas.",
    skipped: 0,
    paused: false,
    requiresConfirmation: false,
    warnings: [],
  };
}

async function runDisparoRiskCheck(payload) {
  try {
    const resp = await fetch("/api/disparo/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));
    const warnings = Array.isArray(data?.warnings)
      ? data.warnings.filter((warning) => typeof warning === "string" && warning.trim())
      : [];
    notifyWarnings(warnings);

    return {
      ok: resp.ok && !data?.error,
      error: data?.error || null,
      warnings,
      blocked: Boolean(data?.blocked),
      requiresConfirmation: Boolean(data?.requiresConfirmation),
      session: data?.session || null,
      validationSession: data?.validationSession || null,
      listQuality: data?.listQuality || null,
    };
  } catch {
    return {
      ok: false,
      error: "Falha ao validar o risco do disparo.",
      warnings: [],
      blocked: true,
      requiresConfirmation: false,
      session: null,
      validationSession: null,
      listQuality: null,
    };
  }
}

function notifyWarnings(warnings = []) {
  warnings.forEach((warning) => {
    const normalized = String(warning || "").trim();
    if (!normalized || shownWarnings.has(normalized)) return;
    shownWarnings.add(normalized);
    notify(normalized, "warn");
  });
}

function shouldStopDisparo(result) {
  if (!result || result.ok) return false;
  if (result.paused || result.requiresConfirmation) return true;

  const message = String(result.error || "").toLowerCase();
  return (
    message.includes("envios só são permitidos") ||
    message.includes("nenhuma sessão ativa") ||
    message.includes("nenhuma sessão conectada") ||
    message.includes("campanha bloqueada") ||
    message.includes("pausada para campanha") ||
    message.includes("limite diario seguro") ||
    message.includes("fase de aquecimento") ||
    message.includes("limite seguro atual") ||
    message.includes("fora do whatsapp") ||
    message.includes("baixa qualidade da lista") ||
    message.includes("muitos numeros inativos")
  );
}

async function startDisparo() {
  clearDisparoFieldErrors();

  if (isSending) {
    notify("⏳ Um disparo já está em andamento. Aguarde terminar.", "warn");
    return;
  }

  const contactsDraft = validateContactsStep();
  if (!contactsDraft) return;

  const draft = validateMessageStep();
  if (!draft) return;

  const originalLabel = refs.btnStart?.innerHTML || DEFAULT_START_LABEL;
  shownWarnings = new Set();
  isPaused = false;
  cancelRequested = false;

  if (refs.btnStart) {
    refs.btnStart.disabled = true;
    refs.btnStart.classList.add("is-busy");
    refs.btnStart.innerHTML = `<i class="fa-solid fa-list-check"></i> Revisando campanha...`;
  }

  if (refs.btnPause) {
    refs.btnPause.disabled = true;
    refs.btnPause.innerHTML = DEFAULT_PAUSE_LABEL;
  }
  if (refs.btnCancel) refs.btnCancel.disabled = true;
  if (refs.btnPrevStep) refs.btnPrevStep.disabled = true;
  if (refs.btnNextStep) refs.btnNextStep.disabled = true;

  const riskKey = buildRiskKey(draft);
  let riskCheck = wizardState.riskCheck;

  if (!riskCheck || wizardState.riskKey !== riskKey) {
    riskCheck = await runDisparoRiskCheck({
      numbers: draft.validNumbers,
      message: draft.message,
      confirmLargeBatch: false,
    });
    wizardState.riskCheck = riskCheck;
    wizardState.riskKey = riskKey;
    renderConfirmSummary(draft, riskCheck);
  }

  if (riskCheck.blocked || (!riskCheck.ok && !riskCheck.requiresConfirmation)) {
    notify(riskCheck.error || "Disparo bloqueado pela política de envio.", "error");
    resetButton(originalLabel);
    return;
  }

  let largeBatchConfirmed = false;
  if (riskCheck.requiresConfirmation) {
    largeBatchConfirmed = true;
    if (refs.btnStart) {
      refs.btnStart.innerHTML = `<i class="fa-solid fa-shield-check"></i> Confirmando lote...`;
    }
    riskCheck = await runDisparoRiskCheck({
      numbers: draft.validNumbers,
      message: draft.message,
      confirmLargeBatch: true,
    });
    wizardState.riskCheck = riskCheck;
    renderConfirmSummary(draft, riskCheck);

    if (!riskCheck.ok) {
      notify(riskCheck.error || "O lote não pôde ser confirmado.", "error");
      resetButton(originalLabel);
      return;
    }
  }

  isSending = true;
  currentStep = 3;
  syncWizardState();

  if (refs.btnStart) {
    refs.btnStart.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> Enviando...`;
  }
  if (refs.btnPause) refs.btnPause.disabled = false;
  if (refs.btnCancel) refs.btnCancel.disabled = false;

  notify("🚀 Iniciando disparo...", "info");

  let fileBase64 = null;
  let filename = null;
  const total = draft.validNumbers.length;
  let successCount = 0;
  let failCount = 0;

  if (draft.file) {
    notify("🖼️ Processando mídia...", "info");
    fileBase64 = await toBase64(draft.file);
    filename = draft.file.name;
  }

  initProgressUI(total);
  appendDispatchLog("info", "", `campanha iniciada com ${total} contato(s).`);
  setProgressStatus("Campanha pronta. Preparando primeiros envios...");
  updateProgressUI();

  try {
    for (let index = 0; index < draft.validNumbers.length; index += 1) {
      const number = draft.validNumbers[index];
      const phoneLabel = formatPhoneDisplay(number);
      await waitWhilePausedOrCancelled();
      setProgressStatus(`Enviando para ${phoneLabel}...`);

      const itemStartedAt = Date.now();
      const result = await sendWithRetry({
        number,
        message: draft.message,
        file: fileBase64,
        filename,
        confirmLargeBatch: largeBatchConfirmed,
      });
      const itemElapsed = Date.now() - itemStartedAt;

      if (result.ok) {
        successCount += 1;
        stats.sent += 1;
        appendDispatchLog("ok", number, `enviado (${formatDispatchElapsed(itemElapsed)})`);
        setProgressStatus(`Enviado para ${phoneLabel}.`);
      } else {
        failCount += 1;
        const failureMessage = result.error || "Falha ao enviar.";
        const classification = classifyDispatchResult(result, failureMessage);

        if (classification.kind === "skip") {
          stats.skipped += 1;
          appendDispatchLog("skip", number, `pulado: ${failureMessage}`);
          setProgressStatus(`Contato pulado: ${phoneLabel}.`);
          updateProgressUI();

          if (index < draft.validNumbers.length - 1) {
            appendDispatchLog("info", "", `aguardando intervalo (${formatDurationLabel(3)})`);
            updateProgressUI();
            await controlledSleep(3000);
          }
          continue;
        }

        stats.failed += 1;
        appendDispatchLog("fail", number, `falha: ${failureMessage}`);
        setProgressStatus(`Falha ao enviar para ${phoneLabel}: ${failureMessage}`);
        notify(`⚠️ ${formatPhoneDisplay(number)}: ${failureMessage}`, "warn");

        if (shouldStopDisparo(result)) {
          throw new Error(failureMessage);
        }
      }

      updateProgressUI();

      if (index < draft.validNumbers.length - 1) {
        appendDispatchLog("info", "", `aguardando intervalo (${formatDurationLabel(3)})`);
        updateProgressUI();
        await controlledSleep(3000);
      }
    }

    setProgressStatus("🎉 Disparo finalizado!");
    progressPhase = "completed";
    appendDispatchLog(
      "info",
      "",
      `campanha concluída: ${stats.sent} envio(s), ${stats.failed} falha(s), ${stats.skipped} pulado(s).`
    );
    updateProgressUI();
    await logDisparoHistory({
      total,
      success: successCount,
      fail: failCount,
      message: draft.message,
      status: "completed",
    });
  } catch (error) {
    if (error?.message === "cancelled") {
      progressPhase = "cancelled";
      setProgressStatus("🛑 Disparo cancelado pelo usuário.");
      appendDispatchLog("info", "", "disparo cancelado pelo operador.");
      updateProgressUI();
      await logDisparoHistory({
        total,
        success: successCount,
        fail: failCount,
        message: draft.message,
        status: "cancelled",
      });
    } else {
      progressPhase = "error";
      const errorMessage = error?.message || "Erro inesperado no disparo.";
      setProgressStatus(errorMessage);
      appendDispatchLog("fail", "", errorMessage);
      updateProgressUI();
      notify(`❌ ${errorMessage}`, "error");
      await logDisparoHistory({
        total,
        success: successCount,
        fail: failCount,
        message: draft.message,
        status: "error",
      });
    }
  } finally {
    resetButton(originalLabel);
  }
}

function resetButton(originalLabel = DEFAULT_START_LABEL) {
  isSending = false;
  isPaused = false;
  cancelRequested = false;
  shownWarnings = new Set();

  if (refs.btnStart) {
    refs.btnStart.disabled = false;
    refs.btnStart.classList.remove("is-busy");
    refs.btnStart.innerHTML = originalLabel || DEFAULT_START_LABEL;
  }
  if (refs.btnPause) {
    refs.btnPause.disabled = true;
    refs.btnPause.innerHTML = DEFAULT_PAUSE_LABEL;
  }
  if (refs.btnCancel) refs.btnCancel.disabled = true;
  if (refs.btnPrevStep) refs.btnPrevStep.disabled = currentStep === 1;
  if (refs.btnNextStep) refs.btnNextStep.disabled = false;

  syncWizardState();
}

function initProgressUI(total) {
  stats = { sent: 0, failed: 0, skipped: 0, total: Number(total || 0) };
  dispatchLog = [];
  startTime = Date.now();
  progressStatus = "Iniciando disparo...";
  progressPhase = "running";
  renderProgressPanel();
}

function setProgressStatus(text) {
  progressStatus = String(text || "").trim() || "Aguardando próximos passos...";
  syncProgressPanelMeta();
}

function renderProgressPanel() {
  if (refs.progressPanel) {
    refs.progressPanel.hidden = false;
  }
  updateProgressUI();
}

function updateProgressUI() {
  syncProgressPanelMeta();

  const total = Math.max(Number(stats.total || 0), 0);
  const processed = getProcessedCount();
  const remaining = Math.max(total - processed, 0);
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

  if (refs.dispBar) refs.dispBar.style.width = `${percent}%`;
  if (refs.dispSent) refs.dispSent.textContent = String(stats.sent);
  if (refs.dispFailed) refs.dispFailed.textContent = String(stats.failed);
  if (refs.dispSkipped) refs.dispSkipped.textContent = String(stats.skipped);
  if (refs.dispRemaining) refs.dispRemaining.textContent = String(remaining);

  renderDispatchLog();
}

function syncProgressPanelMeta() {
  const total = Math.max(Number(stats.total || 0), 0);
  const processed = getProcessedCount();
  const remaining = Math.max(total - processed, 0);

  if (refs.dispTitle) {
    refs.dispTitle.textContent = `${processed} / ${total} processados`;
  }

  if (refs.dispStatusText) {
    refs.dispStatusText.textContent =
      progressStatus || "O painel aparece quando o disparo começar.";
  }

  if (refs.dispEta) {
    if (!startTime || total <= 0) {
      refs.dispEta.textContent = "ETA --:--";
    } else if (processed >= total) {
      refs.dispEta.textContent = `Concluído em ${formatDurationLabel(
        (Date.now() - startTime) / 1000
      )}`;
    } else if (processed <= 0) {
      refs.dispEta.textContent = "ETA calculando...";
    } else {
      const elapsedMs = Math.max(Date.now() - startTime, 1);
      const rate = processed / elapsedMs;
      const etaMs = rate > 0 ? remaining / rate : 0;
      refs.dispEta.textContent = `ETA ${formatDurationLabel(Math.ceil(etaMs / 1000))}`;
    }
  }

  if (refs.dispStatusBadge) {
    const badge = getProgressPhaseMeta();
    refs.dispStatusBadge.className = `disp-badge ${badge.className}`;
    refs.dispStatusBadge.textContent = badge.label;
  }

  if (refs.btnExportLog) {
    refs.btnExportLog.disabled = dispatchLog.length === 0;
  }
}

function renderDispatchLog() {
  if (!refs.dispLog) return;

  const recentEntries = dispatchLog.slice(-MAX_DISPATCH_LOG_LINES);
  if (!recentEntries.length) {
    refs.dispLog.innerHTML =
      '<div class="disp-log-empty">O log ao vivo aparece aqui assim que os envios começarem.</div>';
  } else {
    refs.dispLog.innerHTML = recentEntries
      .map(
        (entry) =>
          `<div class="disp-log-line ${entry.type}">${escapeHtml(entry.message)}</div>`
      )
      .join("");
    refs.dispLog.scrollTop = refs.dispLog.scrollHeight;
  }

  if (refs.dispLogMeta) {
    refs.dispLogMeta.textContent = `${dispatchLog.length} linha(s)`;
  }
}

function appendDispatchLog(type, phone, result) {
  const normalizedType = ["ok", "fail", "skip", "info"].includes(type) ? type : "info";
  const phoneDigits = String(phone || "").replace(/\D/g, "");
  const phoneLabel = phoneDigits ? formatPhoneDisplay(phoneDigits) : "";
  const cleanResult = String(result || "").trim() || "sem detalhes";
  const prefix = getDispatchLogPrefix(normalizedType);
  const message = phoneLabel
    ? `${prefix} ${phoneLabel} - ${cleanResult}`
    : `${prefix} ${cleanResult}`;

  dispatchLog.push({
    type: normalizedType,
    phone: phoneLabel,
    phoneDigits,
    result: cleanResult,
    message,
  });
}

function getDispatchLogPrefix(type) {
  if (type === "ok") return "✓";
  if (type === "fail") return "✕";
  if (type === "skip") return "⚠";
  return "…";
}

function classifyDispatchResult(result, failureMessage) {
  if (isSkippedDispatchResult(result, failureMessage)) {
    return { kind: "skip" };
  }
  return { kind: "fail" };
}

function isSkippedDispatchResult(result, failureMessage) {
  const normalized = String(failureMessage || "").toLowerCase();
  return (
    Number(result?.skipped || 0) > 0 ||
    normalized.includes("pulado") ||
    normalized.includes("duplic") ||
    normalized.includes("supress") ||
    normalized.includes("cooldown") ||
    normalized.includes("histórico recente de falhas") ||
    normalized.includes("historico recente de falhas") ||
    normalized.includes("removido da campanha")
  );
}

function formatDispatchElapsed(ms) {
  const value = Math.max(Number(ms || 0), 0);
  if (value >= 1000) {
    const seconds = value / 1000;
    return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${Math.round(value)}ms`;
}

function getProcessedCount() {
  return stats.sent + stats.failed + stats.skipped;
}

function getProgressPhaseMeta() {
  if (progressPhase === "completed") {
    return { label: "Concluído", className: "is-completed" };
  }
  if (progressPhase === "paused") {
    return { label: "Pausado", className: "is-paused" };
  }
  if (progressPhase === "cancelling") {
    return { label: "Cancelando", className: "is-cancelling" };
  }
  if (progressPhase === "cancelled") {
    return { label: "Cancelado", className: "is-cancelled" };
  }
  if (progressPhase === "error") {
    return { label: "Falha crítica", className: "is-error" };
  }
  if (progressPhase === "running") {
    return { label: "Em andamento", className: "is-running" };
  }
  return { label: "Pronto", className: "is-idle" };
}

function togglePause() {
  if (!isSending || cancelRequested || !refs.btnPause) return;
  isPaused = !isPaused;
  progressPhase = isPaused ? "paused" : "running";
  refs.btnPause.innerHTML = isPaused
    ? `<i class="fa-solid fa-play"></i> Retomar`
    : DEFAULT_PAUSE_LABEL;
  appendDispatchLog("info", "", isPaused ? "disparo pausado manualmente." : "disparo retomado.");
  updateProgressUI();
  setProgressStatus(isPaused ? "⏸️ Disparo pausado" : "▶️ Disparo retomado");
}

function cancelDisparo() {
  if (!isSending) return;
  cancelRequested = true;
  isPaused = false;
  progressPhase = "cancelling";
  if (refs.btnPause) refs.btnPause.innerHTML = DEFAULT_PAUSE_LABEL;
  appendDispatchLog("info", "", "cancelamento solicitado pelo operador.");
  updateProgressUI();
  setProgressStatus("🛑 Cancelando disparo...");
}

function exportLog() {
  if (!dispatchLog.length) {
    notify("Nenhuma linha de log disponível para exportar.", "warn");
    return;
  }

  const csv = [
    "status,telefone,resultado",
    ...dispatchLog.map((entry) =>
      [
        escapeCsvValue(entry.type),
        escapeCsvValue(entry.phoneDigits || ""),
        escapeCsvValue(entry.result),
      ].join(",")
    ),
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `disparo-log-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function logDisparoHistory({ total, success, fail, message, status }) {
  try {
    await fetch("/api/disparo/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        total_numbers: total,
        success_count: success,
        fail_count: fail,
        message,
        status,
      }),
    });
  } catch (error) {
    console.error("Erro ao registrar histórico de disparo:", error);
  }
}

function buildRiskKey(draft) {
  return JSON.stringify({
    numbers: draft.validNumbers,
    message: draft.message,
    fileName: draft.file?.name || "",
  });
}

function formatDurationLabel(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds || 0)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function bindNumbersTextareaMask() {
  if (!refs.numbersInput || refs.numbersInput.dataset.phoneMaskBound === "1") return;

  refs.numbersInput.dataset.phoneMaskBound = "1";
  refs.numbersInput.addEventListener("focus", handleNumbersFocus);
  refs.numbersInput.addEventListener("input", handleNumbersInput);
  refs.numbersInput.addEventListener("keydown", handleNumbersKeydown);
}

function handleNumbersFocus() {
  if (!refs.numbersInput) return;
  if (!refs.numbersInput.value.trim()) {
    refs.numbersInput.value = PHONE_BR_PREFIX;
    refs.numbersInput.setSelectionRange(refs.numbersInput.value.length, refs.numbersInput.value.length);
    return;
  }
  applyNumbersTextareaMask(refs.numbersInput);
}

function handleNumbersInput() {
  if (!refs.numbersInput) return;
  applyNumbersTextareaMask(refs.numbersInput);
  handleDraftMutation();
}

function handleNumbersKeydown(event) {
  if (!refs.numbersInput || event.key !== "Enter") return;

  event.preventDefault();
  const start = refs.numbersInput.selectionStart;
  const end = refs.numbersInput.selectionEnd;
  const value = refs.numbersInput.value;
  const insertion = `\n${PHONE_BR_PREFIX}`;

  refs.numbersInput.value = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  const caret = start + insertion.length;
  refs.numbersInput.setSelectionRange(caret, caret);
  handleDraftMutation();
}

function applyNumbersTextareaMask(textarea) {
  const rawValue = String(textarea.value || "");
  const startMeta = getTextareaCaretMeta(rawValue, textarea.selectionStart);
  const endMeta = getTextareaCaretMeta(rawValue, textarea.selectionEnd);
  const formattedLines = rawValue.split("\n").map(formatPhoneLine);
  const formattedValue = formattedLines.join("\n");

  if (formattedValue !== rawValue) {
    textarea.value = formattedValue;
  }

  const start = getTextareaCaretPosition(formattedLines, startMeta);
  const end = getTextareaCaretPosition(formattedLines, endMeta);
  textarea.setSelectionRange(start, end);
}

function getTextareaCaretMeta(value, position) {
  const before = String(value || "").slice(0, Number(position || 0));
  const parts = before.split("\n");
  return {
    lineIndex: parts.length - 1,
    digitCount: String(parts[parts.length - 1] || "").replace(/\D/g, "").length,
  };
}

function getTextareaCaretPosition(lines, meta) {
  const safeLineIndex = Math.max(0, Math.min(meta.lineIndex, Math.max(lines.length - 1, 0)));
  let absolute = 0;

  for (let index = 0; index < safeLineIndex; index += 1) {
    absolute += String(lines[index] || "").length + 1;
  }

  return absolute + getPositionAfterDigits(String(lines[safeLineIndex] || ""), meta.digitCount);
}

function getPositionAfterDigits(line, digitCount) {
  if (!digitCount) return 0;

  let seen = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (/\d/.test(line[index])) seen += 1;
    if (seen >= digitCount) return index + 1;
  }
  return line.length;
}

function formatPhoneLine(line) {
  const digits = String(line || "").replace(/\D/g, "");
  if (!digits) return "";
  return formatBrazilPhone(normalizeBrazilPhoneDigits(digits));
}

function normalizeBrazilPhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (PHONE_BR_PREFIX.startsWith(digits) && digits.length <= PHONE_BR_PREFIX.length) {
    return PHONE_BR_PREFIX;
  }

  const raw = digits.startsWith(PHONE_BR_PREFIX) ? digits : `${PHONE_BR_PREFIX}${digits}`;
  return raw.slice(0, PHONE_BR_MAX_LENGTH);
}

function formatBrazilPhone(digits) {
  const normalized = normalizeBrazilPhoneDigits(digits);
  const ddiLength = PHONE_BR_PREFIX.length;
  const countryCode = normalized.slice(0, ddiLength);
  const ddd = normalized.slice(ddiLength, ddiLength + 2);
  const phone = normalized.slice(ddiLength + 2);

  let formatted = countryCode;
  if (ddd) {
    formatted += ` (${ddd}`;
    if (ddd.length === 2) formatted += ")";
  }
  if (phone) {
    formatted += ` ${formatBrazilPhoneLocal(phone)}`;
  }
  return formatted;
}

function formatBrazilPhoneLocal(phone) {
  if (phone.length <= 4) return phone;
  if (phone.length <= 8) {
    return `${phone.slice(0, 4)}-${phone.slice(4)}`;
  }
  return `${phone.slice(0, 5)}-${phone.slice(5, 9)}`;
}

function formatPhoneDisplay(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "—";
  if (digits.length > PHONE_BR_MAX_LENGTH && !digits.startsWith(PHONE_BR_PREFIX)) {
    return digits;
  }
  return formatBrazilPhone(digits);
}

function getConfiguredDefaultDdi() {
  const digits = String(document.body?.dataset?.defaultDdi || "55")
    .replace(/\D/g, "")
    .slice(0, 4);

  return digits || "55";
}
