/* ========================================
   ZapConnect Admin Dashboard — dashboard.js
   Dados reais de /admin/dashboard-data
======================================== */

/* ===========================
   ESTADO GLOBAL
=========================== */
const State = {
  allUsers:   [],
  filtered:   [],
  sort:       { key: null, dir: 'asc' },
  page:       1,
  perPage:    15,
  charts:     {},
};

/* ===========================
   INIT
=========================== */
document.addEventListener("DOMContentLoaded", () => {
  loadDashboard();
  bindFilters();
  bindTableSort();
});

/* ===========================
   LOAD
=========================== */
async function loadDashboard() {
  const btn = document.querySelector('.btn-refresh');
  btn?.classList.add('spinning');

  try {
    const res = await fetch("/admin/dashboard-data");

    if (!res.ok) {
      showToast('error', `Erro ao carregar dados (${res.status})`);
      renderTableError();
      return;
    }

    const data = await res.json();
    const stats    = data.stats    || {};
    const users    = data.users    || [];
    const chartData = data.chartData || {};

    State.allUsers = users;
    State.filtered = [...users];
    State.page = 1;

    renderStats(stats);
    renderCharts(stats, users, chartData);
    applyFilters();

  } catch (err) {
    console.error("Erro no dashboard:", err);
    showToast('error', 'Falha na conexão com o servidor');
    renderTableError();
  } finally {
    btn?.classList.remove('spinning');
  }
}

/* ===========================
   STATS
   Campos reais: totalUsers, active, pastDue,
   cancelled, revenue, mrr, ticket, leads, abandoned
=========================== */
function animateValue(el, end, duration = 750) {
  if (!el) return;
  end = Number(end) || 0;
  const startTime = performance.now();
  (function update(now) {
    const t     = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.floor(eased * end).toLocaleString('pt-BR');
    if (t < 1) requestAnimationFrame(update);
  })(startTime);
}

function renderStats(s) {
  const el = document.getElementById("stats");
  if (!el) return;

  // Taxa de conversão: leads → pagantes
  const convRate = s.leads > 0
    ? ((s.active / s.leads) * 100).toFixed(1)
    : '—';

  const items = [
    {
      id: 'stat-total', label: 'Usuários',
      icon: 'fa-users', value: s.totalUsers,
      sub: `${s.leads || 0} leads totais`,
      class: '',
    },
    {
      id: 'stat-active', label: 'Ativos',
      icon: 'fa-circle-check', value: s.active,
      sub: `${convRate}% de conversão`,
      class: 'green',
    },
    {
      id: 'stat-pastdue', label: 'Inadimplentes',
      icon: 'fa-triangle-exclamation', value: s.pastDue,
      sub: s.totalUsers > 0
        ? ((s.pastDue / s.totalUsers) * 100).toFixed(1) + '% do total'
        : '—',
      class: 'yellow',
    },
    {
      id: 'stat-cancelled', label: 'Cancelados',
      icon: 'fa-ban', value: s.cancelled,
      sub: s.totalUsers > 0
        ? 'Churn: ' + ((s.cancelled / s.totalUsers) * 100).toFixed(1) + '%'
        : '—',
      class: 'red',
    },
    {
      id: 'stat-mrr', label: 'MRR (30 dias)',
      icon: 'fa-brazilian-real-sign',
      value: null,
      raw: fmtBRL(s.mrr),
      sub: `Ticket médio: ${fmtBRL(s.ticket)}`,
      class: 'blue',
    },
    {
      id: 'stat-abandoned', label: 'Abandonados',
      icon: 'fa-cart-arrow-down', value: s.abandoned,
      sub: 'Checkout não finalizado',
      class: 'red',
    },
  ];

  el.innerHTML = items.map((item, i) => `
    <div class="card ${item.class}" style="animation-delay:${i * 60}ms">
      <div class="card-icon"><i class="fa-solid ${item.icon}"></i></div>
      <b id="${item.id}">${item.raw || 0}</b>
      <span>${item.label}</span>
      ${item.sub ? `<small class="card-sub">${item.sub}</small>` : ''}
    </div>
  `).join('');

  items.forEach(item => {
    if (item.value !== null && item.value !== undefined) {
      animateValue(document.getElementById(item.id), item.value);
    }
  });
}

/* ===========================
   CHARTS — derivados de users[] e stats
=========================== */
function renderCharts(stats, users, chartData = {}) {
  renderRevenueChart(users, chartData.monthlyRevenue);
  renderDonutChart(stats);
  renderFunnelChart(stats);
  renderDailyChart(users, chartData.dailyNewUsers);
  renderHeatmap(users, chartData.dailyPayments);
  renderTopFails(users);
}

/* Helpers de cor/tema */
const isDark    = window.matchMedia('(prefers-color-scheme: dark)').matches;
const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
const tickColor = isDark ? '#5a6480' : '#94a3b8';

function destroyChart(id) {
  if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; }
}

/* ─── 1. RECEITA MENSAL ───
   Agrupa pagamentos aprovados por mês usando last_payment_at e last_amount */
function renderRevenueChart(users, monthlyRevenue) {
  destroyChart('revenue');
  const ctx = document.getElementById('chart-revenue');
  if (!ctx) return;

  let months, values;

  if (monthlyRevenue && monthlyRevenue.length) {
    // Dados reais do backend: [{ month: '2025-01', total: 4200 }, ...]
    months = monthlyRevenue.map(r => {
      const [year, mon] = r.month.split('-');
      return new Date(Number(year), Number(mon) - 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
    });
    values = monthlyRevenue.map(r => Number(r.total) || 0);
  } else {
    // Fallback: agrupa last_payment_at dos usuários por mês
    const now    = Date.now();
    const mrrMap = {};
    months = [];
    for (let i = 6; i >= 0; i--) {
      const d   = new Date(now);
      d.setMonth(d.getMonth() - i);
      const key = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
      months.push(key);
      mrrMap[key] = 0;
    }
    users.forEach(u => {
      if (!u.last_payment_at || !u.last_amount) return;
      const d   = new Date(Number(u.last_payment_at));
      const key = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
      if (key in mrrMap) mrrMap[key] += Number(u.last_amount) || 0;
    });
    values = months.map(m => mrrMap[m]);
  }

  State.charts.revenue = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [{
        label: 'Receita',
        data: values,
        backgroundColor: 'rgba(79,110,247,0.55)',
        borderColor: '#4f6ef7',
        borderWidth: 1,
        borderRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => 'R$ ' + Number(c.raw).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) } },
      },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } } },
        y: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { size: 11 }, callback: v => 'R$ ' + (v / 1000).toFixed(0) + 'k' },
        },
      },
    },
  });
}

/* ─── 2. DONUT — distribuição de planos ─── */
function renderDonutChart(stats) {
  destroyChart('donut');
  const ctx = document.getElementById('chart-donut');
  if (!ctx) return;

  // Conta planos a partir dos users
  const counts = { free: 0, starter: 0, pro: 0 };
  State.allUsers.forEach(u => {
    const p = (u.plan || 'free').toLowerCase();
    if (p in counts) counts[p]++;
    else counts.free++;
  });

  const total   = State.allUsers.length || 1;
  const paidPct = Math.round(((counts.starter + counts.pro) / total) * 100);

  // Atualiza texto central
  const bigEl = document.querySelector('.donut-big');
  if (bigEl) bigEl.textContent = paidPct + '%';

  State.charts.donut = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Pro', 'Starter', 'Free'],
      datasets: [{
        data: [counts.pro, counts.starter, counts.free],
        backgroundColor: ['#a855f7', '#4f6ef7', '#334155'],
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      cutout: '65%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: c => {
              const pct = Math.round((c.raw / total) * 100);
              return `${c.label}: ${c.raw} (${pct}%)`;
            },
          },
        },
      },
      animation: { animateRotate: true, duration: 900 },
    },
  });

  // Atualiza legenda com números reais
  const legEl = document.querySelector('.donut-legend');
  if (legEl) {
    legEl.innerHTML = `
      <span class="leg-item"><span class="leg-dot" style="background:#a855f7"></span>Pro ${counts.pro}</span>
      <span class="leg-item"><span class="leg-dot" style="background:#4f6ef7"></span>Starter ${counts.starter}</span>
      <span class="leg-item"><span class="leg-dot" style="background:#64748b"></span>Free ${counts.free}</span>
    `;
  }
}

/* ─── 3. FUNIL — dados reais de stats ─── */
function renderFunnelChart(stats) {
  const el = document.getElementById('funnel-chart');
  if (!el) return;

  const leads      = stats.leads      || 0;
  const total      = stats.totalUsers || 0;
  const active     = stats.active     || 0;
  const abandoned  = stats.abandoned  || 0;

  // Referência: leads é o topo do funil
  const ref = leads || total || 1;

  const data = [
    { label: 'Leads',      val: leads,     color: '#6366f1' },
    { label: 'Cadastros',  val: total,     color: '#4f6ef7' },
    { label: 'Ativos',     val: active,    color: '#10b981' },
    { label: 'Abandonados',val: abandoned, color: '#f43f5e' },
  ];

  el.innerHTML = data.map(f => {
    const pct = Math.round((f.val / ref) * 100);
    return `
      <div class="funnel-row">
        <div class="funnel-label">${f.label}</div>
        <div class="funnel-bar-wrap">
          <div class="funnel-bar" style="width:0%;background:${f.color}25;color:${f.color}"
               data-pct="${Math.min(pct, 100)}">
            ${f.val.toLocaleString('pt-BR')}
          </div>
        </div>
        <div class="funnel-pct">${pct}%</div>
      </div>
    `;
  }).join('');

  // Anima as barras
  requestAnimationFrame(() => {
    el.querySelectorAll('.funnel-bar').forEach(bar => {
      bar.style.width = bar.dataset.pct + '%';
    });
  });
}

/* ─── 4. NOVOS USUÁRIOS POR DIA ───
   Agrupa users por data de cadastro (u.id como proxy se não tiver created_at,
   ou usa last_payment_at). */
function renderDailyChart(users, dailyNewUsers) {
  destroyChart('daily');
  const ctx = document.getElementById('chart-daily');
  if (!ctx) return;

  const labels = [], values = [];
  const today  = new Date();

  if (dailyNewUsers && dailyNewUsers.length) {
    // Dados reais: [{ day: '2025-03-01', count: 12 }, ...]
    // Garante os últimos 28 dias mesmo se algum dia não tiver registro
    const dayMap = {};
    dailyNewUsers.forEach(r => { dayMap[r.day] = Number(r.count) || 0; });

    for (let i = 27; i >= 0; i--) {
      const d   = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const lbl = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      labels.push(lbl);
      values.push(dayMap[iso] || 0);
    }
  } else {
    // Fallback: agrupa last_payment_at dos users
    const dayMap = {};
    for (let i = 27; i >= 0; i--) {
      const d   = new Date(today);
      d.setDate(d.getDate() - i);
      const lbl = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      labels.push(lbl);
      dayMap[lbl] = 0;
    }
    users.forEach(u => {
      if (!u.last_payment_at) return;
      const d   = new Date(Number(u.last_payment_at));
      const key = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      if (key in dayMap) dayMap[key]++;
    });
    labels.forEach(l => values.push(dayMap[l]));
  }

  State.charts.daily = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#6366f1',
        backgroundColor: 'rgba(99,102,241,0.1)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.4,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => c.raw + ' pagamentos' } },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: tickColor, font: { size: 10 }, maxTicksLimit: 7, maxRotation: 0 },
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { size: 10 } },
          min: 0,
        },
      },
    },
  });
}

/* ─── 5. HEATMAP — atividade por dia ───
   Usa last_payment_at dos usuários para colorir os dias */
function renderHeatmap(users, dailyPayments) {
  const grid   = document.getElementById('heatmap');
  const daysEl = document.getElementById('hm-days');
  if (!grid) return;

  const dayNames = ['', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  if (daysEl) {
    daysEl.innerHTML = dayNames.map(d => `<div class="hm-day-label">${d}</div>`).join('');
  }

  // Monta mapa dateString → count
  const countMap = {};
  if (dailyPayments && dailyPayments.length) {
    // Dados reais: [{ day: '2025-03-01', count: 8 }, ...]
    dailyPayments.forEach(r => { countMap[r.day] = Number(r.count) || 0; });
  } else {
    // Fallback: usa last_payment_at dos users
    users.forEach(u => {
      if (!u.last_payment_at) return;
      const key = new Date(Number(u.last_payment_at)).toISOString().slice(0, 10);
      countMap[key] = (countMap[key] || 0) + 1;
    });
  }

  const maxCount = Math.max(...Object.values(countMap), 1);

  const palette = isDark
    ? ['rgba(79,110,247,0.08)', 'rgba(79,110,247,0.25)', 'rgba(79,110,247,0.55)', '#4f6ef7']
    : ['rgba(79,110,247,0.06)', 'rgba(79,110,247,0.2)',  'rgba(79,110,247,0.5)',  '#4f6ef7'];

  // Âncora no domingo da semana atual, vai 7 semanas para trás
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Coluna 0 = semana mais antiga, coluna 6 = semana atual
  grid.innerHTML = '';
  grid.style.display = 'flex';
  grid.style.gap = '4px';

  for (let w = 6; w >= 0; w--) {
    const col = document.createElement('div');
    col.className = 'hm-week-col';

    // Label da semana (data do primeiro dia)
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - w * 7 - today.getDay());
    const lbl = document.createElement('div');
    lbl.className = 'hm-week-label';
    lbl.textContent = weekStart.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    col.appendChild(lbl);

    // 7 células = seg a dom
    for (let d = 1; d <= 7; d++) {
      const cell = document.createElement('div');
      cell.className = 'hm-cell';

      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + (d - 1));
      const key   = date.toISOString().slice(0, 10);
      const count = countMap[key] || 0;

      // Nível 0–3 baseado na proporção em relação ao máximo
      const ratio = count / maxCount;
      const level = ratio === 0 ? 0 : ratio < 0.33 ? 1 : ratio < 0.66 ? 2 : 3;
      cell.style.background = palette[level];
      cell.title = `${date.toLocaleDateString('pt-BR')} — ${count} pagamento${count !== 1 ? 's' : ''}`;

      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
}

/* ─── 6. TOP FALHAS — direto de users[] ─── */
function renderTopFails(users) {
  const tbody = document.getElementById('top-fails-table');
  if (!tbody) return;

  const top = [...users]
    .filter(u => (u.failures || 0) > 0)
    .sort((a, b) => (b.failures || 0) - (a.failures || 0))
    .slice(0, 5);

  if (!top.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">
      Nenhuma falha registrada 🎉
    </td></tr>`;
    return;
  }

  tbody.innerHTML = top.map(u => `
    <tr>
      <td title="${escHtml(u.email)}">${escHtml(u.name || u.email || '—')}</td>
      <td><span class="mini-badge ${u.plan || 'free'}">${(u.plan || 'free').toUpperCase()}</span></td>
      <td style="text-align:right;color:var(--red);font-family:var(--font-mono);font-weight:700;font-size:13px">
        ${u.failures}
      </td>
    </tr>
  `).join('');
}

/* ===========================
   TABELA USUÁRIOS
=========================== */
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function renderUsers(users) {
  const tbody = document.getElementById("users");
  if (!tbody) return;

  const total = users.length;
  const start = (State.page - 1) * State.perPage;
  const page  = users.slice(start, start + State.perPage);

  // Contadores
  const countEl = document.getElementById('result-count');
  if (countEl) countEl.textContent = `${total} cliente${total !== 1 ? 's' : ''}`;

  const metaEl = document.getElementById('table-meta');
  if (metaEl) {
    metaEl.textContent = total > State.perPage
      ? `Exibindo ${start + 1}–${Math.min(start + State.perPage, total)} de ${total}`
      : `${total} resultado${total !== 1 ? 's' : ''}`;
  }

  if (!page.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
      <i class="fa-solid fa-user-slash"></i>
      <p>Nenhum cliente encontrado com os filtros aplicados.</p>
    </div></td></tr>`;
    renderPagination(0);
    return;
  }

  tbody.innerHTML = page.map((u, idx) => `
    <tr class="${u.abandoned ? 'abandoned' : ''}" style="animation-delay:${idx * 20}ms">
      <td>
        <div class="user-name">${escHtml(u.name || '—')}</div>
      </td>
      <td class="user-email">${escHtml(u.email || '—')}</td>
      <td>
        <span class="badge plan ${u.plan || 'free'}">
          ${escHtml((u.plan || 'free').toUpperCase())}
        </span>
      </td>
      <td>
        <span class="badge status ${u.subscription_status || 'trial'}">
          ${escHtml(u.subscription_status || 'trial')}
        </span>
        ${u.abandoned ? `<span class="badge danger">Abandonado</span>` : ''}
      </td>
      <td>${formatDate(u.last_payment_at)}</td>
      <td>${escHtml(u.last_method || '—')}</td>
      <td class="${(u.failures || 0) > 0 ? 'danger-cell' : ''}">${u.failures || 0}</td>
    </tr>
  `).join('');

  renderPagination(total);
}

function renderTableError() {
  const tbody = document.getElementById("users");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
    <i class="fa-solid fa-triangle-exclamation"></i>
    <p>Não foi possível carregar os dados. Tente recarregar.</p>
  </div></td></tr>`;
}

/* ===========================
   PAGINAÇÃO
=========================== */
function renderPagination(total) {
  const container = document.getElementById('pagination');
  if (!container) return;
  const pages   = Math.ceil(total / State.perPage);
  if (pages <= 1) { container.innerHTML = ''; return; }

  const current = State.page;
  let html = `<button class="page-btn" onclick="goToPage(${current - 1})" ${current === 1 ? 'disabled' : ''}>
    <i class="fa-solid fa-chevron-left"></i></button>`;

  getPaginationRange(current, pages).forEach(p => {
    html += p === '…'
      ? `<button class="page-btn" disabled>…</button>`
      : `<button class="page-btn ${p === current ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
  });

  html += `<button class="page-btn" onclick="goToPage(${current + 1})" ${current === pages ? 'disabled' : ''}>
    <i class="fa-solid fa-chevron-right"></i></button>`;

  container.innerHTML = html;
}

function getPaginationRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const range = [1];
  if (current > 3) range.push('…');
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) range.push(i);
  if (current < total - 2) range.push('…');
  range.push(total);
  return range;
}

function goToPage(page) {
  const pages = Math.ceil(State.filtered.length / State.perPage);
  if (page < 1 || page > pages) return;
  State.page = page;
  renderUsers(State.filtered);
  document.querySelector('.table-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===========================
   FILTROS
=========================== */
function applyFilters() {
  const search = document.getElementById("search")?.value.toLowerCase().trim() || '';
  const plan   = document.getElementById("plan")?.value  || '';
  const status = document.getElementById("status")?.value || '';

  State.filtered = State.allUsers.filter(u => {
    if (search && !(u.name?.toLowerCase().includes(search) || u.email?.toLowerCase().includes(search))) return false;
    if (plan   && u.plan !== plan)                  return false;
    if (status && u.subscription_status !== status) return false;
    return true;
  });

  if (State.sort.key) sortUsers();
  State.page = 1;
  renderUsers(State.filtered);
}

function bindFilters() {
  const searchEl = document.getElementById('search');
  const clearEl  = document.getElementById('clear-search');

  searchEl?.addEventListener('input', debounce(() => {
    clearEl?.classList.toggle('visible', searchEl.value.length > 0);
    applyFilters();
  }, 280));

  clearEl?.addEventListener('click', () => {
    if (searchEl) searchEl.value = '';
    clearEl.classList.remove('visible');
    applyFilters();
    searchEl?.focus();
  });

  document.getElementById("plan")?.addEventListener('change', applyFilters);
  document.getElementById("status")?.addEventListener('change', applyFilters);
  document.getElementById("export")?.addEventListener('click', exportCSV);
}

/* ===========================
   ORDENAÇÃO
=========================== */
function bindTableSort() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      State.sort.dir = State.sort.key === key && State.sort.dir === 'asc' ? 'desc' : 'asc';
      State.sort.key = key;
      document.querySelectorAll('th[data-sort]').forEach(el => el.classList.remove('asc', 'desc'));
      th.classList.add(State.sort.dir);
      sortUsers();
      State.page = 1;
      renderUsers(State.filtered);
    });
  });
}

function sortUsers() {
  const { key, dir } = State.sort;
  const mul = dir === 'asc' ? 1 : -1;
  State.filtered.sort((a, b) => {
    let va = a[key] ?? '', vb = b[key] ?? '';
    if (key === 'failures' || key === 'last_payment_at') return (Number(va) - Number(vb)) * mul;
    return String(va).toLowerCase().localeCompare(String(vb).toLowerCase()) * mul;
  });
}

/* ===========================
   EXPORTAR CSV
=========================== */
function exportCSV() {
  const users = State.filtered;
  if (!users.length) { showToast('error', 'Nenhum dado para exportar'); return; }

  const BOM    = '\uFEFF';
  const header = 'Nome,Email,Plano,Status,Ultimo Pagamento,Metodo,Valor,Falhas,Abandonado\n';
  const rows   = users.map(u => [
    csvCell(u.name),
    csvCell(u.email),
    csvCell(u.plan),
    csvCell(u.subscription_status),
    csvCell(formatDate(u.last_payment_at)),
    csvCell(u.last_method),
    csvCell(fmtBRL(u.last_amount)),
    u.failures || 0,
    u.abandoned ? 'Sim' : 'Não',
  ].join(','));

  const blob = new Blob([BOM + header + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url,
    download: `clientes-zapconnect-${new Date().toISOString().slice(0, 10)}.csv`,
  }).click();
  URL.revokeObjectURL(url);
  showToast('success', `${users.length} registros exportados`);
}

/* ===========================
   TOAST
=========================== */
function showToast(type, message) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const icons = { success: 'fa-circle-check', error: 'fa-circle-xmark', info: 'fa-circle-info' };
  const toast = Object.assign(document.createElement('div'), {
    className: `toast ${type}`,
    innerHTML: `<i class="fa-solid ${icons[type] || icons.info}"></i> ${escHtml(message)}`,
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

/* ===========================
   UTILITÁRIOS
=========================== */
function fmtBRL(val) {
  return 'R$ ' + (Number(val) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function csvCell(val) {
  return `"${String(val || '').replace(/"/g, '""')}"`;
}

function debounce(fn, delay = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}