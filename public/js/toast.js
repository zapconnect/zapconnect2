(() => {
  const icons = {
    success: "✅",
    error: "⚠️",
    warn: "⚠️",
    info: "ℹ️",
  };

  function ensureContainer() {
    let c = document.querySelector(".toast-container");
    if (!c) {
      c = document.createElement("div");
      c.className = "toast-container";
      document.body.appendChild(c);
    }
    return c;
  }

  window.showToast = function showToast(type = "info", message = "") {
    const container = ensureContainer();
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <div class="toast-body">${message}</div>
    `;
    container.appendChild(t);

    const remove = () => {
      t.classList.add("hide");
      setTimeout(() => t.remove(), 250);
    };
    setTimeout(remove, 3200);

    t.addEventListener("click", remove);
  };
})();
