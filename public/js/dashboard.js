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
  planConfigs: [],
};

/* ===========================
   HELPERS UI
=========================== */
function renderEmptyState(container, message = "Nenhum dado ainda", icon = "fa-chart-line") {
  if (!container) return true;
  container.innerHTML = `
    <div class="empty-state" style="padding:28px 12px">
      <i class="fa-solid ${icon}"></i>
      <p>${message}</p>
    </div>
  `;
  return true;
}

function ensureCanvas(wrap, id) {
  if (!wrap) return null;
  wrap.innerHTML = `<canvas id="${id}"></canvas>`;
  return wrap.querySelector("canvas");
}

/* ===========================
   INIT
=========================== */
document.addEventListener("DOMContentLoaded", () => {
  loadDashboard();
  loadPlanConfigs();
  bindFilters();
  bindTableSort();
  loadTemplates();
  window.addEventListener("resize", () => {
    const grid = document.getElementById('heatmap');
    const days = document.getElementById('hm-days');
    adjustHeatmapSize(grid, days);
  });
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
   DIREITOS DOS PLANOS
=========================== */
async function loadPlanConfigs() {
  try {
    const res = await fetch("/admin/plan-configs");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    State.planConfigs = Array.isArray(data.plans) ? data.plans : [];
    renderPlanConfigs();
  } catch (err) {
    console.error("Erro ao carregar planos:", err);
    const wrap = document.getElementById("plan-configs-grid");
    renderEmptyState(wrap, "Falha ao carregar os planos", "fa-sliders");
  }
}

function formatPlanIaLimit(value) {
  if (String(value).toLowerCase() === "unlimited") return "unlimited";
  return String(value ?? 0);
}

function formatPlanPrice(value) {
  return Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: Number(value || 0) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
}

function getPlanCardData(card) {
  const plan = card?.dataset.plan || "";
  const displayName = card?.querySelector('[data-field="displayName"]')?.value?.trim() || "";
  const badgeLabel = card?.querySelector('[data-field="badgeLabel"]')?.value?.trim() || "";
  const price = Number(card?.querySelector('[data-field="price"]')?.value || 0);
  const maxSessions = Number(card?.querySelector('[data-field="maxSessions"]')?.value || 0);
  const maxIaMessages = card?.querySelector('[data-field="maxIaMessages"]')?.value?.trim() || "0";
  const maxBroadcastNumbers = Number(card?.querySelector('[data-field="maxBroadcastNumbers"]')?.value || 0);
  const featureList = (card?.querySelector('[data-field="featureList"]')?.value || "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  const highlight = Boolean(card?.querySelector('[data-field="highlight"]')?.checked);

  return {
    plan,
    displayName,
    badgeLabel,
    price,
    maxSessions,
    maxIaMessages,
    maxBroadcastNumbers,
    featureList,
    highlight,
  };
}

function renderPlanConfigSummary(card) {
  const summary = card?.querySelector("[data-summary]");
  if (!summary) return;

  const data = getPlanCardData(card);
  const iaLabel = String(data.maxIaMessages).toLowerCase() === "unlimited"
    ? "IA ilimitada"
    : `${data.maxIaMessages || 0} mensagens IA/mês`;

  const bullets = [
    `${data.maxSessions || 0} sessão(ões) simultâneas`,
    iaLabel,
    `${data.maxBroadcastNumbers || 0} número(s) por disparo/agendamento`,
    ...data.featureList.slice(0, 4),
  ];

  summary.innerHTML = `
    <div class="plan-config-summary-title">
      <i class="fa-solid fa-wand-magic-sparkles"></i>
      Preview dos direitos
    </div>
    <ul>
      ${bullets.map(item => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

function bindPlanConfigCard(card) {
  if (!card) return;

  card.querySelectorAll("[data-field]").forEach((field) => {
    const eventName = field.type === "checkbox" ? "change" : "input";
    field.addEventListener(eventName, () => {
      const status = card.querySelector("[data-status]");
      if (status) status.textContent = "";
      card.classList.toggle("is-highlight", Boolean(card.querySelector('[data-field="highlight"]')?.checked));
      renderPlanConfigSummary(card);
    });
  });

  card.querySelector('[data-action="save-plan"]')?.addEventListener("click", async () => {
    const payload = getPlanCardData(card);
    const status = card.querySelector("[data-status]");
    const button = card.querySelector('[data-action="save-plan"]');

    if (!payload.displayName) {
      showToast("error", "Informe o nome exibido do plano");
      return;
    }
    if (!payload.featureList.length) {
      showToast("error", "Informe ao menos um benefício para o plano");
      return;
    }

    const iaValue = String(payload.maxIaMessages).trim().toLowerCase();
    if (iaValue !== "unlimited" && (!Number.isFinite(Number(payload.maxIaMessages)) || Number(payload.maxIaMessages) < 0)) {
      showToast("error", "Mensagens IA deve ser um número ou 'unlimited'");
      return;
    }

    if (status) status.textContent = "Salvando...";
    button?.setAttribute("disabled", "disabled");

    try {
      const res = await fetch("/admin/plan-configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Falha ao salvar");

      State.planConfigs = State.planConfigs.map((plan) =>
        plan.name === data.plan.name ? data.plan : plan
      );
      renderPlanConfigs();
      showToast("success", `Plano ${data.plan.displayName} salvo`);
    } catch (err) {
      console.error("Erro ao salvar plano:", err);
      if (status) status.textContent = "";
      showToast("error", err.message || "Erro ao salvar plano");
    } finally {
      button?.removeAttribute("disabled");
    }
  });

  renderPlanConfigSummary(card);
}

function renderPlanConfigs() {
  const wrap = document.getElementById("plan-configs-grid");
  if (!wrap) return;

  if (!State.planConfigs.length) {
    renderEmptyState(wrap, "Nenhum plano configurado ainda", "fa-sliders");
    return;
  }

  wrap.innerHTML = State.planConfigs.map((plan) => `
    <article class="plan-config-card ${plan.highlight ? "is-highlight" : ""}" data-plan="${plan.name}">
      <div class="plan-config-head">
        <div>
          <span class="plan-config-key">${escapeHtml(plan.name)}</span>
          <h4>${escapeHtml(plan.displayName || plan.name)}</h4>
        </div>
        <span class="plan-config-price">R$ ${formatPlanPrice(plan.price)}${Number(plan.price || 0) > 0 ? "/mês" : ""}</span>
      </div>

      <div class="plan-config-fields">
        <label>Nome exibido</label>
        <input type="text" data-field="displayName" value="${escapeHtml(plan.displayName || "")}" />

        <label>Texto da badge</label>
        <input type="text" data-field="badgeLabel" value="${escapeHtml(plan.badgeLabel || "")}" placeholder="Ex: Popular" />

        <div class="plan-config-inline">
          <div>
            <label>Preço mensal</label>
            <input type="number" min="0" step="0.01" data-field="price" value="${Number(plan.price || 0)}" />
          </div>
          <div>
            <label>Máx. sessões</label>
            <input type="number" min="1" step="1" data-field="maxSessions" value="${Number(plan.maxSessions || 1)}" />
          </div>
        </div>

        <div class="plan-config-inline">
          <div>
            <label>Mensagens IA/mês</label>
            <input type="text" data-field="maxIaMessages" value="${escapeHtml(formatPlanIaLimit(plan.maxIaMessages))}" placeholder="500 ou unlimited" />
          </div>
          <div>
            <label>Máx. números por disparo</label>
            <input type="number" min="1" step="1" data-field="maxBroadcastNumbers" value="${Number(plan.maxBroadcastNumbers || 50)}" />
          </div>
        </div>

        <label>Benefícios no checkout (1 por linha)</label>
        <textarea data-field="featureList" placeholder="1 benefício por linha">${escapeHtml((plan.featureList || []).join("\n"))}</textarea>

        <label class="plan-config-toggle">
          <input type="checkbox" data-field="highlight" ${plan.highlight ? "checked" : ""} />
          Destacar este plano no checkout
        </label>

        <div class="plan-config-summary" data-summary></div>

        <div class="plan-config-actions">
          <button class="btn-export" type="button" data-action="save-plan">
            <i class="fa-solid fa-floppy-disk"></i> Salvar plano
          </button>
          <span class="plan-config-status" data-status>${plan.updatedAt ? `Atualizado em ${new Date(plan.updatedAt).toLocaleString("pt-BR")}` : ""}</span>
        </div>
      </div>
    </article>
  `).join("");

  wrap.querySelectorAll(".plan-config-card").forEach(bindPlanConfigCard);
}

/* ===========================
   TEMPLATES TRIAL
=========================== */
const TemplateState = {
  templates: {},
  current: "trial_day1",
};

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildTemplatePreviewDocument(subject, body, templateLabel, templateKey = "") {
  const previewBaseUrl = window.location.origin || "http://localhost:3000";
  const previewName = "Usuario";
  const resolvedSubject = String(subject || "")
    .replace(/{{\s*BASE_URL\s*}}/g, previewBaseUrl)
    .replace(/{{\s*NAME\s*}}/g, previewName);
  const safeSubject = escapeHtml(resolvedSubject || "Sem assunto");
  const safeLabel = escapeHtml(templateLabel || "Template");
  const rawContent = String(body || "").trim();
  const bodyMatch = rawContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const extractedContent = (bodyMatch ? bodyMatch[1] : rawContent) || "<p>(vazio)</p>";
  let content = extractedContent
    .replace(/{{\s*BASE_URL\s*}}/g, previewBaseUrl)
    .replace(/{{\s*NAME\s*}}/g, previewName);

  if (templateKey === "trial_last") {
    content = content.replace(
      /<p>\s*<a\s+href="[^"]*\/checkout">\s*Fazer upgrade agora\s*<\/a>\s*<\/p>/i,
      `<div style="margin:22px 0;text-align:center;">
        <a href="${previewBaseUrl}/checkout"
          style="
            background:#6C64EF;
            color:#ffffff;
            padding:14px 22px;
            border-radius:12px;
            text-decoration:none;
            font-weight:700;
            display:inline-block;
            font-size:14px;
          ">
          Fazer upgrade agora
        </a>
      </div>`
    );
  }

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${safeSubject}</title>
        <style>
          :root { color-scheme: light; }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Arial, Helvetica, sans-serif;
            background: #f6f7fb;
          }
          .preview-stage {
            padding: 26px 14px;
          }
          .mail-card {
            max-width: 560px;
            margin: 0 auto;
            background: #ffffff;
            border-radius: 16px;
            overflow: hidden;
            box-shadow: 0 8px 30px rgba(0,0,0,0.08);
          }
          .mail-banner {
            background: linear-gradient(135deg,#6C64EF,#4F46E5);
            padding: 22px 26px;
            color: #ffffff;
          }
          .mail-badge {
            display: block;
            font-size: 18px;
            font-weight: 700;
            letter-spacing: 0.2px;
          }
          .mail-banner p {
            margin: 4px 0 0;
            font-size: 13px;
            opacity: 0.9;
          }
          .mail-content {
            padding: 26px;
            color: #374151;
            font-size: 14px;
            line-height: 1.7;
          }
          .mail-content h2 {
            margin: 0 0 12px;
            font-size: 20px;
            line-height: 1.3;
            color: #111827;
          }
          .mail-content img,
          .mail-content video,
          .mail-content table {
            max-width: 100%;
          }
          .mail-content img {
            height: auto;
            border-radius: 12px;
          }
          .mail-content a {
            color: #6C64EF;
          }
          .mail-content p {
            margin: 0 0 16px;
          }
          .mail-content ul,
          .mail-content ol {
            margin: 0 0 16px;
            padding-left: 22px;
          }
          .mail-separator {
            border: none;
            border-top: 1px solid #e5e7eb;
            margin: 22px 0;
          }
          .mail-muted {
            margin: 0;
            font-size: 12px;
            color: #9ca3af;
            line-height: 1.5;
          }
          .mail-footer {
            background: #111827;
            padding: 14px 20px;
            text-align: center;
          }
          .mail-footer p {
            margin: 0;
            color: #9ca3af;
            font-size: 12px;
          }
          .preview-shell {
            background: #f3f4f6;
            padding: 12px;
            border-radius: 12px;
            font-size: 12px;
            color: #111827;
            word-break: break-all;
            line-height: 1.5;
          }
        </style>
      </head>
      <body>
        <div class="preview-stage">
          <div class="mail-card">
            <div class="mail-banner">
              <span class="mail-badge">Zapconnect</span>
              <p>${safeLabel}</p>
            </div>
            <div class="mail-content">
              <h2>Ola, ${previewName} &#128075;</h2>
              <p>Esse e o visual final do e-mail de trial com o template aplicado.</p>
              <div>${content}</div>
              <hr class="mail-separator" />
              <p class="mail-muted">Se precisar de ajuda, basta responder este e-mail.</p>
            </div>
            <div class="mail-footer">
              <p>&copy; ${new Date().getFullYear()} Zapconnect - Atendimento, Automacao e IA no WhatsApp.</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

function updateTemplatePreview() {
  const select = document.getElementById("tpl-select");
  const subject = document.getElementById("tpl-subject");
  const body = document.getElementById("tpl-body");
  const preview = document.getElementById("tpl-preview");
  const previewSubject = document.getElementById("tpl-preview-subject");
  const previewTemplate = document.getElementById("tpl-preview-template");
  const previewDate = document.getElementById("tpl-preview-date");
  const previewWhen = document.getElementById("tpl-preview-when");

  if (!select || !subject || !body || !preview) return;

  const templateLabel = select.options[select.selectedIndex]?.text || "Template";
  const templateKey = select.value || "";
  const nextSubject = subject.value.trim() || "Sem assunto";
  const stamp = new Date();
  const dateLabel = stamp.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
  const timeLabel = stamp.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });

  if (previewSubject) previewSubject.textContent = nextSubject;
  if (previewTemplate) previewTemplate.textContent = templateLabel;
  if (previewDate) previewDate.textContent = `${dateLabel} • ${timeLabel}`;
  if (previewWhen) previewWhen.textContent = `${dateLabel}, ${timeLabel}`;
  preview.srcdoc = buildTemplatePreviewDocument(nextSubject, body.value, templateLabel, templateKey);
}

async function loadTemplates() {
  try {
    const res = await fetch("/admin/email-templates");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const list = data.templates || [];
    TemplateState.templates = {};
    list.forEach(t => { TemplateState.templates[t.template_key] = t; });
    bindTemplateForm();
    renderTemplateForm();
  } catch (err) {
    console.error("Erro ao carregar templates:", err);
    showToast('error', 'Falha ao carregar templates');
  }
}

function bindTemplateForm() {
  const select = document.getElementById("tpl-select");
  const subject = document.getElementById("tpl-subject");
  const body = document.getElementById("tpl-body");
  const preview = document.getElementById("tpl-preview");
  const saveBtn = document.getElementById("tpl-save");

  if (!select || !subject || !body || !preview || !saveBtn) return;

  select.onchange = () => {
    TemplateState.current = select.value;
    renderTemplateForm();
  };

  body.addEventListener("input", () => {
    const st = document.getElementById("tpl-status");
    if (st) st.textContent = "";
    updateTemplatePreview();
  });
  subject.addEventListener("input", () => {
    const st = document.getElementById("tpl-status");
    if (st) st.textContent = "";
    updateTemplatePreview();
  });

  saveBtn.onclick = async () => {
    const key = select.value;
    const subj = subject.value.trim();
    const html = body.value.trim();
    if (!subj || !html) {
      showToast('error', 'Preencha assunto e corpo');
      return;
    }
    setButtonLoading(saveBtn, true, "Salvando...");
    try {
      const res = await fetch("/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, subject: subj, body: html })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      TemplateState.templates[key] = { template_key: key, subject: subj, body: html, updated_at: Date.now() };
      const st = document.getElementById("tpl-status");
      if (st) st.textContent = "Salvo às " + new Date().toLocaleTimeString();
      showToast('success', 'Template salvo');
    } catch (err) {
      console.error("Erro ao salvar template:", err);
      showToast('error', 'Erro ao salvar template');
    } finally {
      setButtonLoading(saveBtn, false);
    }
  };
}

function renderTemplateForm() {
  const key = TemplateState.current;
  const tpl = TemplateState.templates[key];
  if (!tpl) return;
  const subject = document.getElementById("tpl-subject");
  const body = document.getElementById("tpl-body");
  const preview = document.getElementById("tpl-preview");
  const status = document.getElementById("tpl-status");
  if (subject) subject.value = tpl.subject || "";
  if (body) body.value = tpl.body || "";
  if (preview) updateTemplatePreview();
  if (status) status.textContent = tpl.updated_at ? ("Última edição: " + new Date(tpl.updated_at).toLocaleString()) : "Default";
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
  const wrap = document.getElementById('chart-revenue')?.parentElement;
  let ctx = document.getElementById('chart-revenue');
  if (!ctx && wrap) ctx = ensureCanvas(wrap, 'chart-revenue');
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

  const hasData = values.some(v => Number(v) > 0);
  if (!hasData) return renderEmptyState(wrap, "Nenhuma receita registrada", "fa-wallet");

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
  const wrap = document.getElementById('chart-donut')?.parentElement;
  let ctx = document.getElementById('chart-donut');
  if (!ctx && wrap) ctx = ensureCanvas(wrap, 'chart-donut');
  if (!ctx) return;

  // Conta planos a partir dos users
  const counts = { free: 0, starter: 0, pro: 0 };
  State.allUsers.forEach(u => {
    const p = (u.plan || 'free').toLowerCase();
    if (p in counts) counts[p]++;
    else counts.free++;
  });

  const total   = State.allUsers.length || 0;
  const paidPct = Math.round(((counts.starter + counts.pro) / total) * 100);

  if (total === 0) {
    return renderEmptyState(wrap, "Nenhum usuário ainda", "fa-user-slash");
  }

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
  const ref = leads || total;

  if (!ref) {
    return renderEmptyState(el, "Nenhum dado do funil ainda", "fa-filter");
  }

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
  const wrap = document.getElementById('chart-daily')?.parentElement;
  let ctx = document.getElementById('chart-daily');
  if (!ctx && wrap) ctx = ensureCanvas(wrap, 'chart-daily');
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

  const hasData = values.some(v => Number(v) > 0);
  if (!hasData) return renderEmptyState(wrap, "Nenhuma atividade diária ainda", "fa-wave-square");

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

  const entries = Object.values(countMap);
  if (entries.length === 0) {
    if (daysEl) daysEl.innerHTML = "";
    return renderEmptyState(grid, "Nenhuma atividade ainda", "fa-calendar-days");
  }

  const maxCount = Math.max(...entries, 1);

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

  adjustHeatmapSize(grid, daysEl);
}

function adjustHeatmapSize(grid, daysEl) {
  if (!grid) return;
  const GAP = 4;
  const cols = 7; // semanas renderizadas
  const available = grid.clientWidth - (cols - 1) * GAP;
  if (available <= 0) return;
  const size = Math.max(10, Math.min(18, Math.floor(available / cols)));
  grid.style.setProperty('--hm-size', `${size}px`);
  grid.style.setProperty('--hm-gap', `${GAP}px`);
  if (daysEl) {
    daysEl.style.setProperty('--hm-size', `${size}px`);
    daysEl.style.setProperty('--hm-gap', `${GAP}px`);
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
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <i class="fa-solid fa-user-slash"></i>
      <p>Nenhum cliente encontrado com os filtros aplicados.</p>
    </div></td></tr>`;
    renderPagination(0);
    return;
  }

  const avatarColors = ["#6C64EF","#2EE6A6","#F2994A","#5AC8FA","#FF8A65","#8E44AD","#45AAF2","#F2C94C","#26DE81","#E056FD"];
  const makeInitials = (name = "") => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "??";
    if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  };
  const colorFor = (text = "") => {
    let h = 0;
    for (let i=0;i<text.length;i++) h = text.charCodeAt(i) + ((h<<5)-h);
    return avatarColors[Math.abs(h)%avatarColors.length];
  };

  tbody.innerHTML = page.map((u, idx) => {
    const initials = makeInitials(u.name || u.email || "");
    const color = colorFor(u.name || u.email || "");

    return `
    <tr class="${u.abandoned ? 'abandoned' : ''}" style="animation-delay:${idx * 20}ms">
      <td class="col-avatar"><div class="user-avatar" style="background:${color}">${initials}</div></td>
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
  `;
  }).join('');

  renderPagination(total);
}

function renderTableError() {
  const tbody = document.getElementById("users");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
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
  if (window.showToast) {
    window.showToast(type, message);
    return;
  }
  alert(message);
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
