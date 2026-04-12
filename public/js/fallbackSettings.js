// public/js/fallbackSettings.js
const DEFAULTS = {
  fallbackMessage: "Vou encaminhar você para um atendente humano, aguarde um momento.",
  humanModeDuration: 15,
  aiTransferPhrases: ["transferindo...", "vou encaminhar você para um humano"],
  source: "default",
  alertPhone: "",
  alertMessage: "Alerta: assuma a conversa {chatId} da sessão {sessionName}.",
  fallbackCooldownMinutes: 5,
};

let lastConfig = { ...DEFAULTS };
let cachedList = [];
let cachedSessions = [];

function qs(id) {
  return document.getElementById(id);
}

function listToText(arr) {
  return (arr || []).join("\n");
}

function textToList(text) {
  return (text || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function showStatus(msg, ok = true) {
  const box = qs("status-box");
  if (!box) return;
  box.style.display = "block";
  box.className = ok ? "status ok" : "status err";
  box.textContent = msg;
}

function populateSessions(sessions) {
  cachedSessions = sessions || [];
  const select = qs("sessionName");
  if (!select) return;
  if (!cachedSessions.length) {
    select.innerHTML = '<option value="" disabled selected>Nenhuma sessão encontrada</option>';
    return;
  }
  select.innerHTML = cachedSessions
    .map(
      (s, idx) =>
        `<option value="${s.session_name}" ${idx === 0 ? "selected" : ""}>${s.session_name} (${s.status})</option>`
    )
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
      const webhook = item.notify_webhook ? "Sim" : "Não";
      const alert = item.alert_phone ? item.alert_phone : "—";
      return `
        <div class="table-row">
          <span>${item.session_name}</span>
          <span>${webhook}</span>
          <span>${alert}</span>
          <span>${updated}</span>
          <span class="actions-cell">
            <button class="btn-link" data-action="edit" data-session="${item.session_name}">Editar</button>
            <button class="btn-link danger" data-action="delete" data-session="${item.session_name}">Excluir</button>
          </span>
        </div>
      `;
    })
    .join("");

  body.querySelectorAll("button[data-action='edit']").forEach((btn) => {
    btn.onclick = () => {
      const sessionName = btn.getAttribute("data-session") || "";
      qs("sessionName").value = sessionName;
      loadConfig();
    };
  });

  body.querySelectorAll("button[data-action='delete']").forEach((btn) => {
    btn.onclick = async () => {
      const sessionName = btn.getAttribute("data-session") || "";
      if (!sessionName) return;
      const confirmDelete = window.confirm(`Excluir configuração da sessão "${sessionName}"?`);
      if (!confirmDelete) return;
      try {
        const res = await fetch("/api/fallback-settings", {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionName }),
        });
        if (!res.ok) throw new Error("Falha ao excluir configuração.");
        showStatus("Configuração excluída.", true);
        fetchList();
      } catch (err) {
        console.error(err);
        showStatus(err.message || "Erro ao excluir.", false);
      }
    };
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

async function fetchSessions() {
  try {
    const res = await fetch("/api/sessions", { credentials: "include" });
    if (!res.ok) throw new Error("Não foi possível carregar as sessões.");
    const data = await res.json();
    populateSessions(data.sessions || []);
    // auto-load primeira sessão se houver
    const first = (data.sessions || [])[0];
    if (first?.session_name) {
      qs("sessionName").value = first.session_name;
      loadConfig();
    }
  } catch (err) {
    console.error(err);
    populateSessions([]);
    showStatus(err.message || "Erro ao listar sessões.", false);
  }
}

function applyConfig(cfg) {
  const merged = { ...DEFAULTS, ...cfg };
  lastConfig = merged;

  qs("fallbackMessage").value = merged.fallbackMessage ?? DEFAULTS.fallbackMessage;
  const duration = merged.humanModeDuration === null ? 0 : merged.humanModeDuration;
  qs("humanModeDuration").value = Number.isFinite(duration) ? duration : DEFAULTS.humanModeDuration;
  qs("aiTransferPhrases").value = listToText(merged.aiTransferPhrases ?? DEFAULTS.aiTransferPhrases);
  qs("alertPhone").value = merged.alertPhone ?? "";
  qs("alertMessage").value = merged.alertMessage ?? DEFAULTS.alertMessage;
  qs("fallbackCooldownMinutes").value =
    merged.fallbackCooldownMinutes === null || merged.fallbackCooldownMinutes === undefined
      ? DEFAULTS.fallbackCooldownMinutes
      : merged.fallbackCooldownMinutes;
  qs("pill-src").textContent = `Fonte: ${merged.source === "db" ? "Personalizada" : "Padrão"}`;
}

async function loadConfig() {
  const sessionName = qs("sessionName").value.trim();
  if (!sessionName) return showStatus("Informe o sessionName antes de carregar.", false);
  showStatus("Carregando...", true);
  try {
    const res = await fetch(`/api/fallback-settings?sessionName=${encodeURIComponent(sessionName)}`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error("Falha ao carregar configurações.");
    const data = await res.json();
    applyConfig(data.config || DEFAULTS);
    showStatus("Configurações carregadas.", true);
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Erro ao carregar.", false);
  }
}

async function saveConfig() {
  const sessionName = qs("sessionName").value.trim();
  const btnSave = qs("btnSave");
  clearAllFieldErrors(document);
  if (!sessionName) {
    showFieldError("sessionName", "Selecione uma sessão.");
    setButtonLoading(btnSave, false);
    return showStatus("Informe o sessionName antes de salvar.", false);
  }

  const transferList = textToList(qs("aiTransferPhrases").value);
  const payload = {
    sessionName,
    fallbackMessage: qs("fallbackMessage").value.trim() || DEFAULTS.fallbackMessage,
    humanModeDuration: (() => {
      const n = Number(qs("humanModeDuration").value);
      if (!Number.isFinite(n) || n < 0) return 0;
      return n;
    })(),
    aiTransferPhrases: transferList.length ? transferList : DEFAULTS.aiTransferPhrases,
    alertPhone: qs("alertPhone").value.trim(),
    alertMessage: qs("alertMessage").value.trim() || DEFAULTS.alertMessage,
    fallbackCooldownMinutes: (() => {
      const n = Number(qs("fallbackCooldownMinutes").value);
      if (!Number.isFinite(n) || n < 0) return DEFAULTS.fallbackCooldownMinutes;
      return n;
    })(),
  };

  showStatus("Salvando...", true);
  setButtonLoading(btnSave, true, "Salvando...");
  try {
    const res = await fetch("/api/fallback-settings", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Falha ao salvar configurações.");
    const data = await res.json();
    applyConfig(data.config || { ...lastConfig, ...payload });
    showStatus("Configurações salvas e aplicadas.", true);
    fetchList();
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Erro ao salvar.", false);
  } finally {
    setButtonLoading(btnSave, false);
  }
}

function resetLocal() {
  applyConfig(DEFAULTS);
  showStatus("Valores resetados localmente. Clique em salvar para aplicar.", true);
}

window.onload = () => {
  applyConfig(DEFAULTS);
  fetchSessions();
  fetchList();

  qs("btnLoad")?.addEventListener("click", loadConfig);
  qs("btnSave")?.addEventListener("click", saveConfig);
  qs("btnReset")?.addEventListener("click", resetLocal);
  qs("btnRefreshList")?.addEventListener("click", fetchList);
  qs("sessionName")?.addEventListener("change", loadConfig);
};
