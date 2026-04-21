function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ===================================================
// 🔔 NOTIFICAÇÃO (usa toast global)
// ===================================================
function notify(msg, type = "info") {
  showToast(type === "warn" ? "warn" : type, msg);
}

let isSending = false;
let isPaused = false;
let cancelRequested = false;
let isPreviewing = false;
let shownWarnings = new Set();
const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnCancel = document.getElementById("btnCancel");
btnStart.addEventListener("click", startDisparo);
btnPause.addEventListener("click", togglePause);
btnCancel.addEventListener("click", cancelDisparo);

function notifyWarnings(warnings = []) {
  warnings.forEach((warning) => {
    const normalized = String(warning || "").trim();
    if (!normalized || shownWarnings.has(normalized)) return;
    shownWarnings.add(normalized);
    notify(normalized, "warn");
  });
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
          paused: Boolean(data?.paused),
          stoppedReason: data?.stoppedReason || null,
        };
      }

      const error = new Error(data?.error || `Falha ao enviar (HTTP ${resp.status})`);
      error.retryable = data?.retryable !== false && resp.status >= 500;
      error.warnings = warnings;
      error.paused = Boolean(data?.paused);
      error.requiresConfirmation = Boolean(data?.requiresConfirmation);
      throw error;
    } catch (err) {
      if (err?.retryable === false) {
        return {
          ok: false,
          error: err?.message || "Falha ao enviar.",
          warnings: Array.isArray(err?.warnings) ? err.warnings : [],
          paused: Boolean(err?.paused),
          requiresConfirmation: Boolean(err?.requiresConfirmation),
        };
      }

      attempt++;
      if (attempt > maxRetries) break;

      notify(
        `⚠️ Falha no envio, tentando novamente em ${waitMs / 1000}s (tentativa ${attempt}/${maxRetries})...`,
        "warn"
      );
      await controlledSleep(waitMs);
      waitMs *= 2; // backoff crescente
    }
  }

  return {
    ok: false,
    error: "Falha ao enviar após várias tentativas.",
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
      listQuality: null,
    };
  }
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

// ===================================================
// 🚀 DISPARO
// ===================================================
async function startDisparo() {
  clearAllFieldErrors(document);
  if (isSending) {
    notify("⏳ Um disparo já está em andamento. Aguarde terminar.", "warn");
    return;
  }

  const originalLabel = btnStart.innerHTML;
  isPreviewing = true;
  isPaused = false;
  cancelRequested = false;
  btnStart.disabled = true;
  btnStart.classList.add("is-busy");
  btnStart.innerHTML = `<i class="fa-solid fa-list-check"></i> Revisando...`;
  btnPause.disabled = true;
  btnCancel.disabled = true;
  btnPause.innerHTML = `<i class="fa-solid fa-circle-pause"></i> Pausar`;

  const rawLines = document
    .getElementById("numbers")
    .value.trim()
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

  const digitsOnly = rawLines.map((n) => n.replace(/\D/g, ""));
  const numbers = digitsOnly.filter((n) => n.length >= 10 && n.length <= 15);
  const invalidNumbers = digitsOnly.filter(
    (n) => n.length > 0 && (n.length < 10 || n.length > 15)
  );

  const message = document.getElementById("message").value.trim();
  const fileInput = document.getElementById("file");
  const progress = document.getElementById("progress");

  progress.innerHTML = "";

  // ===============================
  // Validações
  // ===============================
  if (!numbers.length) {
    showFieldError("numbers", "Informe pelo menos um número válido (10-15 dígitos).");
    notify("⚠️ Informe pelo menos um número válido (10-15 dígitos).", "error");
    resetButton(originalLabel);
    return;
  }

  if (invalidNumbers.length) {
    notify(
      `⚠️ Números suspeitos (fora de 10-15 dígitos): ${invalidNumbers
        .map((n) => `<span class="pill-suspect">${n}</span>`)
        .join(" ")}`,
      "warn"
    );
  }

  if (!message && fileInput.files.length === 0) {
    showFieldError("message", "Mensagem ou mídia obrigatória.");
    notify("⚠️ Mensagem ou imagem é obrigatória.", "error");
    resetButton(originalLabel);
    return;
  }

  const previewOk = await showPreviewSummary({
    total: rawLines.length,
    valid: numbers.length,
    invalid: invalidNumbers.length,
    invalidList: invalidNumbers.slice(0, 20),
    hasMoreInvalid: invalidNumbers.length > 20,
  });

  if (!previewOk) {
    resetButton(originalLabel);
    return;
  }

  shownWarnings = new Set();

  let largeBatchConfirmed = false;
  let riskCheck = await runDisparoRiskCheck({
    numbers,
    message,
    confirmLargeBatch: false,
  });

  if (riskCheck.requiresConfirmation) {
    const confirmed = confirm(
      riskCheck.error || `Confirmar envio para ${numbers.length} contatos?`
    );
    if (!confirmed) {
      resetButton(originalLabel);
      return;
    }

    largeBatchConfirmed = true;
    riskCheck = await runDisparoRiskCheck({
      numbers,
      message,
      confirmLargeBatch: true,
    });
  }

  if (!riskCheck.ok) {
    notify(riskCheck.error || "Disparo bloqueado pela politica de envio.", "error");
    resetButton(originalLabel);
    return;
  }

  isSending = true;
  isPreviewing = false;
  isPaused = false;
  cancelRequested = false;
  btnStart.innerHTML = `<i class="fa-solid fa-hourglass-half"></i> Enviando...`;
  btnPause.disabled = false;
  btnCancel.disabled = false;
  notify("🚀 Iniciando disparo...", "info");

  let fileBase64 = null;
  let filename = null;
  const total = numbers.length;
  const startedAt = Date.now();
  let successCount = 0;
  let failCount = 0;

  // ===============================
  // Converte mídia uma vez
  // ===============================
  if (fileInput.files.length > 0) {
    notify("🖼️ Processando mídia...", "info");
    const file = fileInput.files[0];
    fileBase64 = await toBase64(file);
    filename = file.name;
  }

  // ===============================
  // Loop de envio
  // ===============================
  initProgressUI(total);

  try {
    for (let i = 0; i < numbers.length; i++) {
      const num = numbers[i];
      await waitWhilePausedOrCancelled();
      setProgressStatus(`Enviando para ${num}...`);

      const result = await sendWithRetry({
        number: num,
        message,
        file: fileBase64,
        filename,
        confirmLargeBatch: largeBatchConfirmed,
      });

      if (result.ok) {
        successCount++;
      } else {
        failCount++;
        const failureMessage = result.error || "Falha ao enviar.";
        setProgressStatus(`Falha ao enviar para ${num}: ${failureMessage}`);
        notify(`⚠️ ${num}: ${failureMessage}`, "warn");

        if (shouldStopDisparo(result)) {
          throw new Error(failureMessage);
        }
      }

      updateProgressUI({
        processed: i + 1,
        total,
        success: successCount,
        fail: failCount,
        startedAt,
      });

      await controlledSleep(3000); // ⏳ cooldown entre envios
    }

    setProgressStatus("🎉 Disparo finalizado!");
    updateProgressUI({
      processed: total,
      total,
      success: successCount,
      fail: failCount,
      startedAt,
    });
    await logDisparoHistory({
      total,
      success: successCount,
      fail: failCount,
      message,
      status: "completed",
    });
  } catch (err) {
    if (err?.message === "cancelled") {
      setProgressStatus("🛑 Disparo cancelado pelo usuário.");
      await logDisparoHistory({
        total,
        success: successCount,
        fail: failCount,
        message,
        status: "cancelled",
      });
    } else {
      setProgressStatus("❌ Erro inesperado no disparo.");
      await logDisparoHistory({
        total,
        success: successCount,
        fail: failCount,
        message,
        status: "error",
      });
    }
  } finally {
    resetButton(originalLabel);
  }
}

function resetButton(originalLabel) {
  isSending = false;
  isPreviewing = false;
  shownWarnings = new Set();
  btnStart.disabled = false;
  btnStart.classList.remove("is-busy");
  btnStart.innerHTML =
    originalLabel || `<i class="fa-solid fa-rocket"></i> Iniciar Disparo`;
  btnPause.disabled = true;
  btnCancel.disabled = true;
  btnPause.innerHTML = `<i class="fa-solid fa-circle-pause"></i> Pausar`;
  isPaused = false;
  cancelRequested = false;
}

function initProgressUI(total) {
  const progress = document.getElementById("progress");
  progress.style.display = "block";
  progress.innerHTML = `
    <div class="progress-header">
      <span id="progress-status">Iniciando...</span>
      <span id="progress-percent">0%</span>
    </div>
    <div class="progress-bar">
      <div id="progress-bar-fill" style="width:0%"></div>
    </div>
    <div class="progress-meta">
      <span id="progress-count">0/${total}</span>
      <span id="progress-eta">ETA --:--</span>
      <span id="progress-success">Sucesso: 0</span>
      <span id="progress-fail">Falhas: 0</span>
    </div>
  `;
}

function setProgressStatus(text) {
  const el = document.getElementById("progress-status");
  if (el) el.textContent = text;
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--:--";
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function updateProgressUI({ processed, total, success, fail, startedAt }) {
  const percent = Math.round((processed / total) * 100);
  const now = Date.now();
  const elapsed = now - startedAt;
  const avgPerItem = processed ? elapsed / processed : 0;
  const remaining = total - processed;
  const etaSeconds = avgPerItem ? (remaining * avgPerItem) / 1000 : 0;

  const fill = document.getElementById("progress-bar-fill");
  if (fill) fill.style.width = `${percent}%`;

  const percentEl = document.getElementById("progress-percent");
  if (percentEl) percentEl.textContent = `${percent}%`;

  const countEl = document.getElementById("progress-count");
  if (countEl) countEl.textContent = `${processed}/${total}`;

  const etaEl = document.getElementById("progress-eta");
  if (etaEl) etaEl.textContent = `ETA ${formatEta(etaSeconds)}`;

  const successEl = document.getElementById("progress-success");
  if (successEl) successEl.textContent = `Sucesso: ${success}`;

  const failEl = document.getElementById("progress-fail");
  if (failEl) failEl.textContent = `Falhas: ${fail}`;
}

function togglePause() {
  if (!isSending || cancelRequested) return;
  isPaused = !isPaused;
  btnPause.innerHTML = isPaused
    ? `<i class="fa-solid fa-play"></i> Retomar`
    : `<i class="fa-solid fa-circle-pause"></i> Pausar`;
  setProgressStatus(isPaused ? "⏸️ Disparo pausado" : "▶️ Disparo retomado");
}

function cancelDisparo() {
  if (!isSending) return;
  cancelRequested = true;
  isPaused = false;
  btnPause.innerHTML = `<i class="fa-solid fa-circle-pause"></i> Pausar`;
  setProgressStatus("🛑 Cancelando disparo...");
}

async function showPreviewSummary({
  total,
  valid,
  invalid,
  invalidList,
  hasMoreInvalid,
}) {
  return new Promise((resolve) => {
    const progress = document.getElementById("progress");
    progress.style.display = "block";

    const invalidHtml =
      invalidList && invalidList.length
        ? `<div class="preview-invalid">
             <strong>Inválidos (${invalid}):</strong>
             <div>${invalidList
               .map((n) => `<span class="pill-suspect">${n}</span>`)
               .join(" ")}${hasMoreInvalid ? " ..." : ""}</div>
           </div>`
        : "";

    progress.innerHTML = `
      <div class="preview-box">
        <div class="preview-row"><span>Total detectados:</span><strong>${total}</strong></div>
        <div class="preview-row"><span>Válidos (10-15 dígitos):</span><strong>${valid}</strong></div>
        <div class="preview-row"><span>Serão ignorados:</span><strong>${invalid}</strong></div>
        ${invalidHtml}
        <div class="preview-actions">
          <button id="btnConfirmPreview" class="btn-primary"><i class="fa-solid fa-rocket"></i> Confirmar envio</button>
          <button id="btnCancelPreview" class="btn-secondary"><i class="fa-solid fa-circle-xmark"></i> Cancelar</button>
        </div>
      </div>
    `;

    const confirmBtn = document.getElementById("btnConfirmPreview");
    const cancelBtn = document.getElementById("btnCancelPreview");

    const cleanup = () => {
      confirmBtn?.removeEventListener("click", onConfirm);
      cancelBtn?.removeEventListener("click", onCancel);
    };

    const onConfirm = () => {
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    confirmBtn?.addEventListener("click", onConfirm);
    cancelBtn?.addEventListener("click", onCancel);
  });
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
  } catch (err) {
    console.error("Erro ao registrar histórico de disparo:", err);
  }
}
