const API = window.location.origin;

function togglePassword() {
  const input = document.getElementById("password");
  const icon = document.getElementById("eyeIcon");

  if (input.type === "password") {
    input.type = "text";
    icon.classList.remove("fa-eye");
    icon.classList.add("fa-eye-slash");
  } else {
    input.type = "password";
    icon.classList.remove("fa-eye-slash");
    icon.classList.add("fa-eye");
  }
}

async function login() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errEmail = document.getElementById("email-error");
  const errPass  = document.getElementById("password-error");

  if (errEmail) errEmail.textContent = "";
  if (errPass)  errPass.textContent  = "";

  if (!email || !password) {
    if (errEmail) errEmail.textContent = !email ? "Informe seu email" : "";
    if (errPass)  errPass.textContent  = !password ? "Informe sua senha" : "";
    return;
  }

  let res;
  try {
    res = await fetch(API + "/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
  } catch (err) {
    alert("Erro de conexão. Tente novamente.");
    return;
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  // ✅ se backend mandou redirect, vai SEMPRE
  if (data.redirect) {
    window.location.href = data.redirect;
    return;
  }

  // ❌ erro normal
  if (!res.ok || data.error) {
    const msg = (data.error || "").toLowerCase();
    if (msg.includes("email") || msg.includes("usuário")) {
      if (errEmail) errEmail.textContent = data.error || "E-mail não encontrado";
    } else if (msg.includes("senha") || msg.includes("password")) {
      if (errPass) errPass.textContent = data.error || "Senha incorreta";
    } else {
      if (errPass) errPass.textContent = data.error || "Não foi possível entrar";
    }
    return;
  }

  // ✅ login ok
  window.location.href = "/painel";
}
