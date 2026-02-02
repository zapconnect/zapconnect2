let ALL_USERS = [];
let FILTERED_USERS = [];

/* =========================
   🚀 INIT
========================= */
loadDashboard();

/* =========================
   📥 LOAD
========================= */
async function loadDashboard() {
  const res = await fetch("/admin/dashboard-data");
  const data = await res.json();

  ALL_USERS = data.users;
  FILTERED_USERS = [...ALL_USERS];

  renderStats(data.stats);
  renderUsers(FILTERED_USERS);
}

/* =========================
   📊 STATS (com animação)
========================= */
function animateValue(el, start, end, duration = 600) {
  const startTime = performance.now();

  function update(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const value = Math.floor(progress * (end - start) + start);
    el.textContent = value;
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

function renderStats(stats) {
  const el = document.getElementById("stats");

  el.innerHTML = `
    <div class="card"><b id="stat-total">0</b><span>Total de usuários</span></div>
    <div class="card green"><b id="stat-active">0</b><span>Ativos</span></div>
    <div class="card yellow"><b id="stat-pastdue">0</b><span>Inadimplentes</span></div>
    <div class="card red"><b id="stat-cancelled">0</b><span>Cancelados</span></div>
    <div class="card blue"><b id="stat-revenue">R$ 0</b><span>Receita</span></div>
    <div class="card red"><b id="stat-failed">0</b><span>Falhas</span></div>
  `;

  animateValue(document.getElementById("stat-total"), 0, stats.totalUsers);
  animateValue(document.getElementById("stat-active"), 0, stats.active);
  animateValue(document.getElementById("stat-pastdue"), 0, stats.pastDue);
  animateValue(document.getElementById("stat-cancelled"), 0, stats.cancelled);
  animateValue(document.getElementById("stat-failed"), 0, stats.failed);

  document.getElementById("stat-revenue").textContent =
    `R$ ${stats.revenue.toFixed(2)}`;
}

/* =========================
   👤 TABELA
========================= */
function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("pt-BR");
}

function renderUsers(users) {
  const tbody = document.getElementById("users");

  tbody.innerHTML = users.map(u => `
    <tr class="${u.abandoned ? "abandoned" : ""}">
      <td>${u.name}</td>
      <td>${u.email}</td>
      <td>
        <span class="badge plan ${u.plan}">
          ${u.plan.toUpperCase()}
        </span>
      </td>
      <td>
        <span class="badge status ${u.subscription_status}">
          ${u.subscription_status}
        </span>
        ${u.abandoned ? `<span class="badge danger">ABANDONADO</span>` : ""}
      </td>
      <td>${formatDate(u.last_payment_at)}</td>
      <td>${u.last_method || "—"}</td>
      <td class="${u.failures > 0 ? "danger" : ""}">
        ${u.failures}
      </td>
    </tr>
  `).join("");
}

/* =========================
   🔍 FILTROS (com debounce)
========================= */
function applyFilters() {
  const search = document.getElementById("search").value.toLowerCase();
  const plan = document.getElementById("plan").value;
  const status = document.getElementById("status").value;

  FILTERED_USERS = ALL_USERS.filter(u => {
    if (
      search &&
      !u.name.toLowerCase().includes(search) &&
      !u.email.toLowerCase().includes(search)
    ) return false;

    if (plan && u.plan !== plan) return false;
    if (status && u.subscription_status !== status) return false;

    return true;
  });

  renderUsers(FILTERED_USERS);
}

/* debounce simples */
function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

document.getElementById("search")
  .addEventListener("input", debounce(applyFilters, 300));

document.getElementById("plan")
  .addEventListener("change", applyFilters);

document.getElementById("status")
  .addEventListener("change", applyFilters);

/* =========================
   📤 EXPORTAR CSV (FILTRADO)
========================= */
document.getElementById("export").addEventListener("click", () => {
  let csv = "Nome,Email,Plano,Status,Ultimo Pagamento,Metodo,Falhas\n";

  FILTERED_USERS.forEach(u => {
    csv += `"${u.name}","${u.email}","${u.plan}","${u.subscription_status}","${formatDate(u.last_payment_at)}","${u.last_method || ""}","${u.failures}"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "clientes-zapconnect.csv";
  a.click();

  URL.revokeObjectURL(url);
});
