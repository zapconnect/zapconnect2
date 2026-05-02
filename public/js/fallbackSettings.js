const DEFAULTS = {
  enableFallback: true,
  fallbackMessage: "Vou encaminhar você para um atendente humano, aguarde um momento.",
  sendTransferMessage: false,
  internalNoteOnly: true,
  repetitionEnabled: true,
  directRequestEnabled: true,
  frustrationEnabled: true,
  aiUncertaintyEnabled: true,
  aiTransferEnabled: true,
  handoverEnabled: true,
  alertEnabled: false,
  fallbackSensitivity: "medium",
  maxRepetitions: 3,
  maxFrustration: 2,
  maxIaFailures: 2,
  triggerWords: [
    "humano",
    "pessoa",
    "atendente",
    "falar com humano",
    "falar com atendente",
    "suporte humano",
  ],
  frustrationWords: [
    "reclamação",
    "reclamacao",
    "frustrado",
    "frustrada",
    "cansado",
    "cansada",
    "irritado",
    "irritada",
    "não funciona",
    "nao funciona",
    "péssimo",
    "pessimo",
    "de novo",
  ],
  aiUncertaintyPhrases: [
    "não tenho certeza",
    "nao tenho certeza",
    "não entendi",
    "nao entendi",
    "não consegui",
    "nao consegui",
    "pode fornecer mais detalhes",
    "pode repetir",
    "não sei",
    "nao sei",
  ],
  aiTransferPhrases: [
    "transferindo...",
    "vou encaminhar você para um humano",
    "vou transferir você para um atendente",
  ],
  humanModeDuration: 15,
  notifyPanel: true,
  notifyWebhook: false,
  webhookUrl: "",
  alertPhone: "",
  alertMessage: "Alerta: assuma a conversa {chatId} da sessão {sessionName}.",
  fallbackCooldownMinutes: 5,
  source: "default",
};

const LIST_FIELDS = new Set([
  "triggerWords",
  "frustrationWords",
  "aiUncertaintyPhrases",
  "aiTransferPhrases",
]);

const NUMBER_FIELDS = new Set([
  "maxRepetitions",
  "maxFrustration",
  "maxIaFailures",
  "humanModeDuration",
  "fallbackCooldownMinutes",
]);

const TOGGLE_FIELDS = new Set([
  "enableFallback",
  "sendTransferMessage",
  "repetitionEnabled",
  "directRequestEnabled",
  "frustrationEnabled",
  "aiUncertaintyEnabled",
  "aiTransferEnabled",
  "handoverEnabled",
  "notifyPanel",
  "alertEnabled",
  "notifyWebhook",
]);

const CONFIG_FIELDS = [
  "enableFallback",
  "sendTransferMessage",
  "directRequestEnabled",
  "triggerWords",
  "repetitionEnabled",
  "maxRepetitions",
  "frustrationEnabled",
  "frustrationWords",
  "maxFrustration",
  "fallbackSensitivity",
  "aiUncertaintyEnabled",
  "aiUncertaintyPhrases",
  "maxIaFailures",
  "aiTransferEnabled",
  "aiTransferPhrases",
  "fallbackMessage",
  "handoverEnabled",
  "humanModeDuration",
  "fallbackCooldownMinutes",
  "notifyPanel",
  "alertEnabled",
  "alertPhone",
  "alertMessage",
  "notifyWebhook",
  "webhookUrl",
];

const RULE_CONFIG = {
  directRequestEnabled: ["triggerWords"],
  repetitionEnabled: ["maxRepetitions"],
  frustrationEnabled: ["frustrationWords", "maxFrustration", "fallbackSensitivity"],
  aiUncertaintyEnabled: ["aiUncertaintyPhrases", "maxIaFailures"],
  aiTransferEnabled: ["aiTransferPhrases"],
  sendTransferMessage: ["fallbackMessage"],
  handoverEnabled: ["humanModeDuration", "fallbackCooldownMinutes"],
  notifyPanel: [],
  alertEnabled: ["alertPhone", "alertMessage"],
  notifyWebhook: ["webhookUrl"],
};

const DETECTION_RULES = [
  "directRequestEnabled",
  "repetitionEnabled",
  "frustrationEnabled",
  "aiUncertaintyEnabled",
  "aiTransferEnabled",
];

const ACTION_RULES = [
  "sendTransferMessage",
  "handoverEnabled",
  "notifyPanel",
  "alertEnabled",
  "notifyWebhook",
];

const SAVE_DEBOUNCE_MS = 800;

let currentConfig = { ...DEFAULTS };
let settingsBuffer = {};
let saveTimeout = null;
let isHydrating = false;
let cachedSessions = [];
let cachedList = [];

function qs(id) {
  return document.getElementById(id);
}

function listToText(arr) {
  return (arr || []).join("\n");
}

function textToList(text) {
  return String(text || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function setSaveState(kind, message) {
  const pill = qs("pill-save-state");
  if (!pill) return;
  pill.textContent = message;
  pill.className = `pill ${kind}`;
}

function showStatus(message, ok = true) {
  const box = qs("status-box");
  if (!box) return;
  box.style.display = "block";
  box.className = ok ? "status ok" : "status err";
  box.textContent = message;
}

function hideStatus() {
  const box = qs("status-box");
  if (!box) return;
  box.style.display = "none";
  box.textContent = "";
}

function getSessionName() {
  return String(qs("sessionName")?.value || "").trim();
}

function getFieldValue(key) {
  const el = qs(key);
  if (!el) return undefined;

  if (TOGGLE_FIELDS.has(key)) {
    return !!el.checked;
  }

  if (LIST_FIELDS.has(key)) {
    return textToList(el.value);
  }

  if (NUMBER_FIELDS.has(key)) {
    const numeric = Number(el.value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return DEFAULTS[key];
    }
    return numeric;
  }

  return String(el.value || "");
}

function updateSourcePill(source) {
  const pill = qs("pill-src");
  if (!pill) return;
  pill.textContent = `Fonte: ${source === "db" ? "Personalizada" : "Padrão"}`;
}

function countActiveRules(keys) {
  return keys.filter((key) => currentConfig[key] === true).length;
}

function updateRuleCounters() {
  const detectBadge = qs("detectRulesBadge");
  const actionBadge = qs("actionRulesBadge");

  if (detectBadge) {
    const total = countActiveRules(DETECTION_RULES);
    detectBadge.textContent = `${total} regra${total === 1 ? "" : "s"} ativa${total === 1 ? "" : "s"}`;
  }

  if (actionBadge) {
    const total = countActiveRules(ACTION_RULES);
    actionBadge.textContent = `${total} regra${total === 1 ? "" : "s"} ativa${total === 1 ? "" : "s"}`;
  }
}

function syncRuleCards() {
  Object.entries(RULE_CONFIG).forEach(([toggleKey, fieldIds]) => {
    const toggle = qs(toggleKey);
    const card = document.querySelector(`[data-rule="${toggleKey}"]`);
    const enabled = !!toggle?.checked;
    if (!card) return;

    card.classList.toggle("rule-disabled", !enabled);
    fieldIds.forEach((fieldId) => {
      const field = qs(fieldId);
      if (!field) return;
      field.disabled = !enabled;
    });
  });

  const shell = qs("fallbackShell");
  if (shell) {
    shell.classList.toggle("shell-paused", !currentConfig.enableFallback);
  }

  updateRuleCounters();
}

function applyConfig(config) {
  const merged = {
    ...DEFAULTS,
    ...config,
    alertEnabled:
      config?.alertEnabled !== undefined
        ? !!config.alertEnabled
        : Boolean(config?.alertPhone),
  };

  currentConfig = {
    ...merged,
    internalNoteOnly: merged.sendTransferMessage ? false : true,
  };

  isHydrating = true;

  CONFIG_FIELDS.forEach((key) => {
    const el = qs(key);
    if (!el) return;

    if (TOGGLE_FIELDS.has(key)) {
      el.checked = !!currentConfig[key];
      return;
    }

    if (LIST_FIELDS.has(key)) {
      el.value = listToText(currentConfig[key]);
      return;
    }

    const value = currentConfig[key];
    el.value = value === null || value === undefined ? "" : String(value);
  });

  isHydrating = false;

  updateSourcePill(currentConfig.source);
  syncRuleCards();
}

function buildPayloadFromDefaults() {
  return {
    ...DEFAULTS,
    sessionName: getSessionName(),
    source: undefined,
  };
}

function queueSave(key, value) {
  if (isHydrating) return;
  const sessionName = getSessionName();
  if (!sessionName) {
    showStatus("Selecione uma sessão antes de editar as regras.", false);
    return;
  }

  hideStatus();
  currentConfig[key] = value;
  settingsBuffer[key] = value;

  if (key === "sendTransferMessage") {
    currentConfig.internalNoteOnly = !value;
    settingsBuffer.internalNoteOnly = !value;
  }

  syncRuleCards();
  setSaveState("saving", "Salvando alterações...");

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveSettings();
  }, SAVE_DEBOUNCE_MS);
}

async function saveSettings() {
  const sessionName = getSessionName();
  if (!sessionName) return;
  if (!Object.keys(settingsBuffer).length) return;

  const payload = {
    sessionName,
    ...settingsBuffer,
  };

  try {
    setSaveState("saving", "Salvando alterações...");
    const res = await fetch("/api/fallback-settings", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error("Não foi possível salvar as alterações do fallback.");
    }

    const data = await res.json();
    settingsBuffer = {};
    applyConfig(data.config || currentConfig);
    setSaveState("saved", "Salvo agora");
    fetchList();
  } catch (err) {
    console.error(err);
    setSaveState("error", "Erro ao salvar");
    showStatus(err.message || "Erro ao salvar fallback.", false);
  }
}

async function flushPendingSave() {
  if (!Object.keys(settingsBuffer).length) return;
  clearTimeout(saveTimeout);
  saveTimeout = null;
  await saveSettings();
}

function populateSessions(sessions) {
  cachedSessions = sessions || [];
  const select = qs("sessionName");
  if (!select) return;

  if (!cachedSessions.length) {
    select.innerHTML = '<option value="" disabled selected>Nenhuma sessão encontrada</option>';
    setSaveState("error", "Nenhuma sessão encontrada");
    return;
  }

  select.innerHTML = cachedSessions
    .map((session) => {
      const label = `${session.session_name} (${session.status})`;
      return `<option value="${session.session_name}">${label}</option>`;
    })
    .join("");
}

function renderList(items) {
  cachedList = items || [];
  const body = qs("fallbackList");
  if (!body) return;

  if (!cachedList.length) {
    body.innerHTML = '<div class="table-row muted-row">Nenhuma configuração salva.</div>';
    return;
  }

  body.innerHTML = cachedList
    .map((item) => {
      const updated = item.updated_at ? new Date(item.updated_at).toLocaleString() : "—";
      const fallbackState = item.enable_fallback ? "Ligado" : "Desligado";
      const webhookState = item.notify_webhook ? "Ativo" : "—";

      return `
        <div class="table-row">
          <span>${item.session_name}</span>
          <span>${fallbackState}</span>
          <span>${webhookState}</span>
          <span>${updated}</span>
          <span class="actions-cell">
            <button class="btn-link" data-action="edit" data-session="${item.session_name}">Editar</button>
            <button class="btn-link danger" data-action="delete" data-session="${item.session_name}">Excluir</button>
          </span>
        </div>
      `;
    })
    .join("");

  body.querySelectorAll("[data-action='edit']").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionName = String(button.getAttribute("data-session") || "");
      if (!sessionName) return;
      await flushPendingSave();
      qs("sessionName").value = sessionName;
      await loadConfig();
    });
  });

  body.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionName = String(button.getAttribute("data-session") || "");
      if (!sessionName) return;

      const confirmed = window.confirm(`Excluir a configuração da sessão "${sessionName}"?`);
      if (!confirmed) return;

      try {
        const res = await fetch("/api/fallback-settings", {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionName }),
        });

        if (!res.ok) {
          throw new Error("Não foi possível excluir a configuração.");
        }

        showStatus("Configuração excluída com sucesso.", true);
        fetchList();
      } catch (err) {
        console.error(err);
        showStatus(err.message || "Erro ao excluir configuração.", false);
      }
    });
  });
}

async function fetchList() {
  try {
    const res = await fetch("/api/fallback-settings/list", { credentials: "include" });
    if (!res.ok) throw new Error("Não foi possível carregar a lista.");
    const data = await res.json();
    renderList(data.items || []);
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Erro ao listar configurações.", false);
  }
}

async function loadConfig() {
  const sessionName = getSessionName();
  if (!sessionName) return;

  setSaveState("saving", "Carregando sessão...");
  hideStatus();

  try {
    const res = await fetch(`/api/fallback-settings?sessionName=${encodeURIComponent(sessionName)}`, {
      credentials: "include",
    });

    if (!res.ok) {
      throw new Error("Não foi possível carregar a configuração dessa sessão.");
    }

    const data = await res.json();
    settingsBuffer = {};
    applyConfig(data.config || DEFAULTS);
    setSaveState("saved", "Sessão carregada");
  } catch (err) {
    console.error(err);
    setSaveState("error", "Erro ao carregar");
    showStatus(err.message || "Erro ao carregar configuração.", false);
  }
}

async function fetchSessions() {
  try {
    const res = await fetch("/api/sessions", { credentials: "include" });
    if (!res.ok) throw new Error("Não foi possível carregar as sessões.");
    const data = await res.json();
    populateSessions(data.sessions || []);

    const firstSession = data.sessions?.[0]?.session_name;
    if (firstSession) {
      qs("sessionName").value = firstSession;
      await loadConfig();
    }
  } catch (err) {
    console.error(err);
    setSaveState("error", "Erro ao buscar sessões");
    showStatus(err.message || "Erro ao listar sessões.", false);
  }
}

async function handleSessionChange() {
  await flushPendingSave();
  await loadConfig();
}

async function resetCurrentSession() {
  const sessionName = getSessionName();
  if (!sessionName) {
    showStatus("Selecione uma sessão antes de restaurar o padrão.", false);
    return;
  }

  const confirmed = window.confirm(`Restaurar os padrões da sessão "${sessionName}"?`);
  if (!confirmed) return;

  clearTimeout(saveTimeout);
  saveTimeout = null;
  settingsBuffer = {};
  applyConfig(DEFAULTS);

  try {
    setSaveState("saving", "Restaurando padrão...");
    const res = await fetch("/api/fallback-settings", {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayloadFromDefaults()),
    });

    if (!res.ok) {
      throw new Error("Não foi possível restaurar o padrão.");
    }

    const data = await res.json();
    applyConfig(data.config || DEFAULTS);
    setSaveState("saved", "Padrão restaurado");
    showStatus("Configuração restaurada para o padrão.", true);
    fetchList();
  } catch (err) {
    console.error(err);
    setSaveState("error", "Erro ao restaurar");
    showStatus(err.message || "Erro ao restaurar padrão.", false);
  }
}

function bindFieldEvents() {
  CONFIG_FIELDS.forEach((key) => {
    const el = qs(key);
    if (!el) return;

    const eventName =
      TOGGLE_FIELDS.has(key) || el.tagName === "SELECT" ? "change" : "input";

    el.addEventListener(eventName, () => {
      const value = getFieldValue(key);
      queueSave(key, value);
    });
  });

  qs("sessionName")?.addEventListener("change", handleSessionChange);
  qs("btnResetSession")?.addEventListener("click", resetCurrentSession);
  qs("btnRefreshList")?.addEventListener("click", fetchList);
}

window.addEventListener("beforeunload", (event) => {
  if (!Object.keys(settingsBuffer).length) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("load", async () => {
  applyConfig(DEFAULTS);
  bindFieldEvents();
  fetchList();
  await fetchSessions();
});
