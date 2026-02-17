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

  if (!email || !password) {
    alert("Digite email e senha");
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
    alert(data.error || "Erro ao fazer login");
    return;
  }

  // ✅ login ok
  window.location.href = "/painel";
}
