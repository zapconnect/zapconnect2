/**
 * Aplica estado de loading padronizado em botões.
 * - Desabilita clique
 * - Mostra spinner + texto fornecido
 * - Restaura conteúdo original ao finalizar
 */
window.setButtonLoading = function setButtonLoading(btn, isLoading, label = "Processando...") {
  if (!btn) return;

  if (isLoading) {
    if (!btn.dataset.originalHtml) {
      btn.dataset.originalHtml = btn.innerHTML;
    }
    btn.classList.add("is-loading");
    btn.disabled = true;
    const safeLabel = label || "Processando...";
    btn.innerHTML = `
      <span class="loading-content">
        <span class="spinner-inline" aria-hidden="true"></span>
        <span class="loading-label">${safeLabel}</span>
      </span>
    `;
  } else {
    const original = btn.dataset.originalHtml;
    if (original) {
      btn.innerHTML = original;
      delete btn.dataset.originalHtml;
    }
    btn.classList.remove("is-loading");
    btn.disabled = false;
  }
};

function resolveEl(target) {
  if (!target) return null;
  if (typeof target === "string") return document.getElementById(target);
  return target;
}

window.clearFieldError = function clearFieldError(target) {
  const el = resolveEl(target);
  if (!el) return;
  el.classList.remove("input-error");
  const next = el.nextElementSibling;
  if (next && next.classList.contains("field-error")) {
    next.remove();
  }
};

window.showFieldError = function showFieldError(target, message) {
  const el = resolveEl(target);
  if (!el) return;
  clearFieldError(el);
  el.classList.add("input-error");
  const msg = document.createElement("div");
  msg.className = "field-error";
  msg.textContent = message;
  el.insertAdjacentElement("afterend", msg);
};

window.clearAllFieldErrors = function clearAllFieldErrors(root = document) {
  root.querySelectorAll(".input-error").forEach((el) => el.classList.remove("input-error"));
  root.querySelectorAll(".field-error").forEach((el) => el.remove());
};

/* ==========================================================
   Transições suaves entre páginas (fade 150ms)
   Aplica classe no body e intercepta <a> do mesmo domínio.
========================================================== */
(function initPageFade() {
  if (window.__pageFadeInstalled) return;
  window.__pageFadeInstalled = true;

  const style = document.createElement("style");
  style.textContent = `
    body.page-fade{opacity:0;transition:opacity .18s ease;}
    body.page-fade.ready{opacity:1;}
    body.page-fade.fade-out{opacity:0;}
  `;
  document.head.appendChild(style);

  document.body.classList.add("page-fade");
  window.requestAnimationFrame(() => document.body.classList.add("ready"));

  const sameOrigin = (href) => {
    try { const u=new URL(href, window.location.href); return u.origin === window.location.origin; }
    catch { return false; }
  };

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    if (a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    if (!sameOrigin(href)) return;
    e.preventDefault();
    document.body.classList.add("fade-out");
    setTimeout(() => { window.location.href = href; }, 160);
  });
})();
