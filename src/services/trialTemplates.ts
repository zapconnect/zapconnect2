import { getDB } from "../database";

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
<p><a href="{{BASE_URL}}/checkout">Fazer upgrade agora</a></p>`,
  },
};

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
