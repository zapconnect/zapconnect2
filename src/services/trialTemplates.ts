import { getDB } from "../database";
import {
  buildZapconnectEmailShell,
  replaceEmailTemplateVariables,
} from "../utils/zapconnectEmailShell";

export type TrialTemplateKey = "trial_day1" | "trial_day3" | "trial_day6" | "trial_last";

type TemplateRow = { template_key: TrialTemplateKey; subject: string; body: string; updated_at: number };

const defaults: Record<TrialTemplateKey, { subject: string; body: string }> = {
  trial_day1: {
    subject: "Seu dia 1 de trial — comece aqui",
    body: `<h2>Bem-vindo ao seu teste do ZapConnect!</h2>
<p>Checklist rápido:</p>
<ol>
  <li>Conectar sessão WhatsApp.</li>
  <li>Subir primeira campanha ou fluxo.</li>
  <li>Habilitar IA nos chats.</li>
</ol>
<p>Precisa de ajuda? Responda este e-mail.</p>`,
  },
  trial_day3: {
    subject: "Dica do dia 3: ganhe tempo com fluxos",
    body: `<h2>Dia 3: ative a automação</h2>
<p>Dica: configure fluxos ou mensagens de boas-vindas para capturar leads automaticamente.</p>
<p>Veja também o painel de métricas para acompanhar uso da IA.</p>`,
  },
  trial_day6: {
    subject: "Dia 6: ajuste fino e pronto",
    body: `<h2>Dia 6: quase lá</h2>
<p>Revise seu catálogo/FAQ na base de conhecimento para respostas mais precisas.</p>
<p>Quer ajuda para calibrar a IA? Responda este e-mail.</p>`,
  },
  trial_last: {
    subject: "Oferta de upgrade exclusiva - termina hoje",
    body: `<h2>Último dia do seu trial</h2>
<p>Aproveite 20% off no primeiro mês usando o cupom <strong>UPGRADE20</strong> até hoje.</p>
<div style="margin:22px 0;text-align:center;">
  <a href="{{BASE_URL}}/checkout"
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
</div>`,
  },
};

const trialEmailMeta: Record<
  TrialTemplateKey,
  { subtitle: string; leadText: string; outroText: string }
> = {
  trial_day1: {
    subtitle: "Boas-vindas ao trial",
    leadText: "Seu periodo de teste comecou. Aqui estao os primeiros passos para voce gerar resultado rapido com o Zapconnect.",
    outroText: "Se quiser ajuda para configurar sua operacao, basta responder este e-mail.",
  },
  trial_day3: {
    subtitle: "Dica pratica do trial",
    leadText: "Passamos aqui no meio do trial com uma dica pratica para voce ganhar tempo e acelerar seu atendimento.",
    outroText: "Se quiser, podemos te ajudar a montar o melhor fluxo para o seu caso.",
  },
  trial_day6: {
    subtitle: "Ajustes finais do trial",
    leadText: "Seu trial esta quase no fim, entao este e um bom momento para fazer os ultimos ajustes e extrair mais valor da IA.",
    outroText: "Se quiser calibrar melhor sua base ou seus fluxos, e so responder este e-mail.",
  },
  trial_last: {
    subtitle: "Ultimo dia do trial",
    leadText: "Seu periodo de teste esta terminando. Este e o melhor momento para manter tudo ativo sem perder sua operacao.",
    outroText: "Se tiver qualquer duvida sobre planos ou upgrade, nossa equipe pode te ajudar.",
  },
};

function buildTrialUpgradeButton(url: string) {
  return `<div style="margin:22px 0;text-align:center;">
  <a href="${url}"
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
</div>`;
}

function normalizeTrialEmailBody(key: TrialTemplateKey, body: string, baseUrl: string) {
  if (key !== "trial_last") return body;

  const checkoutUrl = `${baseUrl}/checkout`;
  return body.replace(
    /<p>\s*<a\s+href="[^"]*\/checkout">\s*Fazer upgrade agora\s*<\/a>\s*<\/p>/i,
    buildTrialUpgradeButton(checkoutUrl)
  );
}

export async function listTrialTemplates(): Promise<TemplateRow[]> {
  const db = getDB();
  const rows = await db.all<TemplateRow>(`SELECT template_key, subject, body, updated_at FROM email_templates`);
  const map: Record<string, TemplateRow> = {};
  rows.forEach(r => { map[r.template_key] = r; });

  // Ensure defaults present in the response (without writing)
  const out: TemplateRow[] = [];
  (Object.keys(defaults) as TrialTemplateKey[]).forEach(key => {
    if (map[key]) out.push(map[key]);
    else out.push({ template_key: key, subject: defaults[key].subject, body: defaults[key].body, updated_at: 0 });
  });
  return out;
}

export async function getTrialTemplate(key: TrialTemplateKey): Promise<{ subject: string; body: string }> {
  const db = getDB();
  const row = await db.get<TemplateRow>(
    `SELECT template_key, subject, body FROM email_templates WHERE template_key = ?`,
    [key]
  );
  if (row) return { subject: row.subject, body: row.body };
  return defaults[key];
}

export function renderTrialEmailTemplate(params: {
  key: TrialTemplateKey;
  subject: string;
  body: string;
  baseUrl: string;
  name?: string | null;
}) {
  const { key, subject, body, baseUrl, name } = params;
  const greetingName = String(name || "usuario").trim() || "usuario";
  const templateVars = {
    BASE_URL: baseUrl,
    NAME: greetingName,
  };
  const meta = trialEmailMeta[key];
  const resolvedSubject = replaceEmailTemplateVariables(subject, templateVars);
  const resolvedBody = normalizeTrialEmailBody(
    key,
    replaceEmailTemplateVariables(body, templateVars),
    baseUrl
  );

  return {
    subject: resolvedSubject,
    html: buildZapconnectEmailShell({
      subtitle: meta.subtitle,
      greetingName,
      leadText: meta.leadText,
      contentHtml: resolvedBody,
      outroText: meta.outroText,
    }),
  };
}

export async function saveTrialTemplate(params: { key: TrialTemplateKey; subject: string; body: string }) {
  const { key, subject, body } = params;
  const db = getDB();
  const now = Date.now();
  await db.run(
    `INSERT INTO email_templates (template_key, subject, body, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), updated_at = VALUES(updated_at)`,
    [key, subject, body, now]
  );
}

export function availableTrialKeys(): TrialTemplateKey[] {
  return Object.keys(defaults) as TrialTemplateKey[];
}
