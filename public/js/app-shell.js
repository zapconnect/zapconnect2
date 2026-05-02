(() => {
  const body = document.body;
  const sidebar = document.querySelector(".app-shell-sidebar");
  const toggles = Array.from(document.querySelectorAll("[data-app-shell-toggle]"));
  const closers = document.querySelectorAll("[data-app-shell-close]");
  const links = document.querySelectorAll(".app-shell-link, .app-shell-mobile-tab[href]");
  const collapseButton = document.querySelector("[data-app-shell-collapse]");
  const collapseIcon = document.querySelector("[data-app-shell-collapse-icon]");
  const collapseCopy = document.querySelector("[data-app-shell-collapse-copy]");
  const collapsedStorageKey = "zapconnect:app-shell-collapsed";

  if (!body || !sidebar || !toggles.length) return;

  const isDesktop = () => window.innerWidth > 1024;

  const readCollapsedPreference = () => {
    try {
      return window.localStorage?.getItem(collapsedStorageKey) === "true";
    } catch {
      return false;
    }
  };

  const writeCollapsedPreference = (isCollapsed) => {
    try {
      window.localStorage?.setItem(collapsedStorageKey, String(Boolean(isCollapsed)));
    } catch {
      // Mantem o toggle funcional mesmo se o navegador bloquear storage
    }
  };

  const setOpen = (isOpen) => {
    body.classList.toggle("app-shell-open", isOpen);
    toggles.forEach((toggle) => {
      toggle.setAttribute("aria-expanded", String(isOpen));
    });
  };

  const setCollapsed = (isCollapsed, { persist = true } = {}) => {
    const shouldCollapse = Boolean(isCollapsed) && isDesktop();
    body.classList.toggle("app-shell-collapsed", shouldCollapse);

    if (collapseButton) {
      const label = shouldCollapse ? "Expandir barra lateral" : "Recolher barra lateral";
      collapseButton.setAttribute("aria-pressed", String(shouldCollapse));
      collapseButton.setAttribute("aria-label", label);
      collapseButton.setAttribute("title", label);
      collapseButton.setAttribute(
        "data-app-shell-label",
        shouldCollapse ? "Expandir menu" : "Recolher menu"
      );
    }

    if (collapseIcon) {
      collapseIcon.className = `fa-solid ${shouldCollapse ? "fa-angles-right" : "fa-angles-left"}`;
    }

    if (collapseCopy) {
      collapseCopy.textContent = shouldCollapse ? "Expandir menu" : "Recolher menu";
    }

    if (persist) {
      writeCollapsedPreference(isCollapsed);
    }
  };

  const toggleOpen = () => setOpen(!body.classList.contains("app-shell-open"));
  const toggleCollapsed = () => {
    setCollapsed(!body.classList.contains("app-shell-collapsed"));
  };

  toggles.forEach((toggle) => {
    toggle.addEventListener("click", toggleOpen);
  });
  closers.forEach((element) => {
    element.addEventListener("click", () => setOpen(false));
  });
  collapseButton?.addEventListener("click", toggleCollapsed);

  links.forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });

  const syncViewportState = () => {
    if (isDesktop()) {
      setOpen(false);
      setCollapsed(readCollapsedPreference(), { persist: false });
      return;
    }

    setCollapsed(false, { persist: false });
    setOpen(false);
  };

  window.addEventListener("resize", syncViewportState);
  syncViewportState();

  const chatLinks = document.querySelectorAll("[data-app-shell-chat-link='true']");
  chatLinks.forEach((chatLink) => {
    chatLink.addEventListener("click", (event) => {
      const sessions = Array.isArray(window._cachedSessions) ? window._cachedSessions : null;
      if (!sessions) return;

      const hasConnectedSession = sessions.some((session) => session && session.status === "connected");
      if (hasConnectedSession) return;

      event.preventDefault();
      const message = "Nenhum WhatsApp conectado. Crie e escaneie uma sessão primeiro.";
      if (typeof window.notify === "function") {
        window.notify(message, "warning");
      } else {
        window.alert(message);
      }
      document.getElementById("sessions-list")?.scrollIntoView({ behavior: "smooth" });
      setOpen(false);
    });
  });
})();
