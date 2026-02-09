function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
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
// 🔔 NOTIFICAÇÃO INLINE
// ===================================================
function notify(msg, type = "info") {
  const progress = document.getElementById("progress");
  progress.style.display = "block";

  const colors = {
    success: "#2EE6A6",
    error: "#E54848",
    warn: "#F2C94C",
    info: "#AAB0D9"
  };

  progress.innerHTML += `
    <div style="
      margin:6px 0;
      padding:8px 10px;
      border-left:4px solid ${colors[type]};
      background:#0f1530;
      border-radius:6px;
      font-size:14px;
    ">
      ${msg}
    </div>
  `;
}

document.getElementById("btnStart").addEventListener("click", startDisparo);

// ===================================================
// 🚀 DISPARO
// ===================================================
async function startDisparo() {
  const numbers = document.getElementById("numbers").value
    .trim()
    .split("\n")
    .map(n => n.replace(/\D/g, ""))
    .filter(n => n.length >= 12);

  const message = document.getElementById("message").value.trim();
  const fileInput = document.getElementById("file");
  const progress = document.getElementById("progress");

  progress.innerHTML = "";

  // ===============================
  // 🔎 Validações
  // ===============================
  if (!numbers.length) {
    notify("⚠️ Informe pelo menos um número válido.", "error");
    return;
  }

  if (!message && fileInput.files.length === 0) {
    notify("⚠️ Mensagem ou imagem é obrigatória.", "error");
    return;
  }

  notify("🚀 Iniciando disparo...", "info");

  let fileBase64 = null;
  let filename = null;

  // ===============================
  // 📎 Converte mídia uma vez
  // ===============================
  if (fileInput.files.length > 0) {
    notify("📎 Processando mídia...", "info");
    const file = fileInput.files[0];
    fileBase64 = await toBase64(file);
    filename = file.name;
  }

  // ===============================
  // 🔁 Loop de envio
  // ===============================
  for (let i = 0; i < numbers.length; i++) {
    const num = numbers[i];
    notify(`📤 Enviando para <b>${num}</b>...`, "info");

    try {
      const resp = await fetch("/api/disparo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          number: num,
          message,
          file: fileBase64,
          filename
        })
      });

      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error();

      notify(`✔️ Enviado com sucesso para <b>${num}</b>`, "success");

    } catch {
      notify(`❌ Falha ao enviar para <b>${num}</b>`, "error");
    }

    await sleep(3000); // ⏳ anti-ban
  }

  notify("🎉 Disparo finalizado!", "success");
}
