(function () {
  const STORAGE_KEY = "_did";

  function canvasFingerprint() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 50;
      const ctx = canvas.getContext("2d");
      if (!ctx) return "no-canvas";
      ctx.textBaseline = "top";
      ctx.font = "16px Arial";
      ctx.fillStyle = "#f60";
      ctx.fillRect(0, 0, 100, 40);
      ctx.fillStyle = "#069";
      ctx.fillText("zapconnect-fp", 2, 20);
      ctx.strokeStyle = "#ff5500";
      ctx.strokeRect(5, 5, 180, 30);
      return canvas.toDataURL();
    } catch (err) {
      return "canvas-error";
    }
  }

  async function sha256(text) {
    if (typeof crypto === "undefined" || !crypto.subtle || typeof TextEncoder === "undefined") {
      return `fallback-${Math.random().toString(36).slice(2)}`;
    }

    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function generateFingerprint() {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;

    const parts = [
      navigator.userAgent || "",
      String(screen.width || ""),
      String(screen.height || ""),
      navigator.language || "",
      String(navigator.hardwareConcurrency || ""),
      navigator.platform || "",
      canvasFingerprint(),
    ];

    const raw = parts.join("::");
    const hash = await sha256(raw);
    localStorage.setItem(STORAGE_KEY, hash);
    return hash;
  }

  window.getDeviceFingerprint = async function getDeviceFingerprint() {
    try {
      const existing = localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      return await generateFingerprint();
    } catch (err) {
      console.warn("deviceFingerprint_error", err);
      return null;
    }
  };

  // Pre-carrega para reduzir latencia no envio do formulario
  generateFingerprint().catch(() => null);
})();
