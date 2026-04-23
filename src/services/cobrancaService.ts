import { getDB, type DBClient, withDBTransaction } from "../database";
import { getClient } from "../wppManager";

export type BillingType =
  | "PIX"
  | "BOLETO"
  | "CARTAO"
  | "TRANSFERENCIA"
  | "DINHEIRO"
  | "OUTRO";

export type ChargeStatus =
  | "PENDENTE"
  | "PAGO"
  | "VENCIDO"
  | "CANCELADO"
  | "PARCIAL";

export type CycleType =
  | "SEMANAL"
  | "QUINZENAL"
  | "MENSAL"
  | "TRIMESTRAL"
  | "SEMESTRAL"
  | "ANUAL";

export type CobrancaCliente = {
  id: number;
  user_id: number;
  nome: string;
  telefone: string;
  email?: string;
  cpf_cnpj?: string;
  observacoes?: string;
  created_at: number;
};

export type Cobranca = {
  id: number;
  user_id: number;
  cliente_id: number;
  cliente_nome: string;
  cliente_telefone: string;
  billing_type: BillingType;
  valor: number;
  valor_pago?: number;
  descricao: string;
  vencimento: string;
  status: ChargeStatus;
  observacoes?: string;
  chave_pix?: string;
  link_pagamento?: string;
  multa_percentual?: number;
  juros_percentual?: number;
  desconto_percentual?: number;
  desconto_limite_dias?: number;
  parcelas?: number;
  parcela_atual?: number;
  cobranca_pai_id?: number;
  recorrente: boolean;
  recorrencia_id?: number;
  session_name?: string;
  notificado_criacao: boolean;
  notificado_vencimento: boolean;
  notificado_atraso: boolean;
  pago_em?: number;
  created_at: number;
  updated_at: number;
};

export type Recorrencia = {
  id: number;
  user_id: number;
  cliente_id: number;
  cliente_nome: string;
  billing_type: BillingType;
  cycle: CycleType;
  valor: number;
  descricao: string;
  proxima_cobranca: string;
  data_fim?: string;
  ativa: boolean;
  session_name?: string;
  created_at: number;
};

export type CreateCobrancaInput = {
  user_id: number;
  cliente_id?: number;
  nome: string;
  telefone: string;
  email?: string;
  cpf_cnpj?: string;
  billing_type: BillingType;
  valor: number;
  vencimento: string;
  descricao: string;
  observacoes?: string;
  chave_pix?: string;
  link_pagamento?: string;
  multa_percentual?: number;
  juros_percentual?: number;
  desconto_percentual?: number;
  desconto_limite_dias?: number;
  parcelas?: number;
  recorrente?: boolean;
  cycle?: CycleType;
  data_fim?: string;
  session_name?: string;
  enviar_whatsapp?: boolean;
};

export type CobrancaSummary = {
  total_pendente: number;
  total_pago: number;
  total_vencido: number;
  total_cancelado: number;
  valor_pendente: number;
  valor_pago_mes: number;
  valor_vencido: number;
  total_clientes: number;
  total_recorrencias_ativas: number;
};

export type ChargeMessageType =
  | "criacao"
  | "lembrete_vencimento"
  | "atraso"
  | "confirmacao_pagamento"
  | "cancelamento";

export type ChargeMessageTemplates = Record<ChargeMessageType, string | null>;

type ClienteRow = {
  id: number;
  user_id: number;
  nome: string;
  telefone: string;
  email: string | null;
  cpf_cnpj: string | null;
  observacoes: string | null;
  created_at: number;
  updated_at: number;
};

type CobrancaRow = {
  id: number;
  user_id: number;
  cliente_id: number;
  cliente_nome: string;
  cliente_telefone: string;
  billing_type: BillingType;
  valor: number | string;
  valor_pago: number | string | null;
  descricao: string;
  vencimento: string;
  status: ChargeStatus;
  observacoes: string | null;
  chave_pix: string | null;
  link_pagamento: string | null;
  multa_percentual: number | string | null;
  juros_percentual: number | string | null;
  desconto_percentual: number | string | null;
  desconto_limite_dias: number | null;
  parcelas: number | null;
  parcela_atual: number | null;
  cobranca_pai_id: number | null;
  recorrente: number | boolean;
  recorrencia_id: number | null;
  session_name: string | null;
  notificado_criacao: number | boolean;
  notificado_vencimento: number | boolean;
  notificado_atraso: number | boolean;
  pago_em: number | null;
  created_at: number;
  updated_at: number;
};

type RecorrenciaRow = {
  id: number;
  user_id: number;
  cliente_id: number;
  cliente_nome: string;
  billing_type: BillingType;
  cycle: CycleType;
  valor: number | string;
  descricao: string;
  proxima_cobranca: string;
  data_fim: string | null;
  ativa: number | boolean;
  session_name: string | null;
  created_at: number;
  updated_at: number;
};

type ChargeInsertInput = {
  user_id: number;
  cliente_id: number;
  cliente_nome: string;
  cliente_telefone: string;
  billing_type: BillingType;
  valor: number;
  descricao: string;
  vencimento: string;
  status: ChargeStatus;
  observacoes?: string;
  chave_pix?: string;
  link_pagamento?: string;
  multa_percentual?: number;
  juros_percentual?: number;
  desconto_percentual?: number;
  desconto_limite_dias?: number;
  parcelas?: number;
  parcela_atual?: number;
  cobranca_pai_id?: number;
  recorrente?: boolean;
  recorrencia_id?: number;
  session_name?: string;
  notificado_criacao?: boolean;
  notificado_vencimento?: boolean;
  notificado_atraso?: boolean;
  valor_pago?: number;
  pago_em?: number;
};

type UserChargePreferencesRow = {
  default_session_name: string | null;
  template_cobranca_criacao: string | null;
  template_cobranca_lembrete: string | null;
  template_cobranca_atraso: string | null;
  template_cobranca_confirmacao: string | null;
  template_cobranca_cancelamento: string | null;
};

type UserChargePreferences = {
  defaultSessionName?: string;
  templates: ChargeMessageTemplates;
};

const BILLING_TYPES: BillingType[] = [
  "PIX",
  "BOLETO",
  "CARTAO",
  "TRANSFERENCIA",
  "DINHEIRO",
  "OUTRO",
];

const CYCLE_TYPES: CycleType[] = [
  "SEMANAL",
  "QUINZENAL",
  "MENSAL",
  "TRIMESTRAL",
  "SEMESTRAL",
  "ANUAL",
];

const DEFAULT_CHARGE_MESSAGE_TEMPLATES: Record<ChargeMessageType, string> = {
  criacao: [
    "📋 *Nova Cobrança*",
    "",
    "Olá, {{primeiro_nome}}! 👋",
    "Você tem uma cobrança pendente:",
    "",
    "💰 *Valor:* {{valor}}",
    "📅 *Vencimento:* {{vencimento}}",
    "💳 *Forma de pagamento:* {{forma_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "{{#chave_pix}}",
    "🔑 *Chave PIX:* {{chave_pix}}",
    "{{/chave_pix}}",
    "{{#link_pagamento}}",
    "🔗 *Link para pagamento:* {{link_pagamento}}",
    "{{/link_pagamento}}",
    "{{#extras}}",
    "{{extras}}",
    "{{/extras}}",
    "",
    "Qualquer dúvida, estamos à disposição! ✅",
  ].join("\n"),
  lembrete_vencimento: [
    "⏰ *Lembrete de Vencimento*",
    "",
    "Olá, {{primeiro_nome}}! Sua cobrança vence {{quando_vence}}:",
    "",
    "💰 *Valor:* {{valor}}",
    "📅 *Vencimento:* {{vencimento}}",
    "💳 *Forma de pagamento:* {{forma_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "{{#chave_pix}}",
    "🔑 *Chave PIX:* {{chave_pix}}",
    "{{/chave_pix}}",
    "{{#link_pagamento}}",
    "🔗 *Link para pagamento:* {{link_pagamento}}",
    "{{/link_pagamento}}",
    "{{#extras}}",
    "{{extras}}",
    "{{/extras}}",
    "",
    "Se precisar de qualquer apoio, estamos por aqui. ✅",
  ].join("\n"),
  atraso: [
    "🔴 *Cobrança em Atraso*",
    "",
    "Olá, {{primeiro_nome}}! Identificamos uma cobrança em aberto:",
    "",
    "💰 *Valor:* {{valor}}",
    "📅 *Vencimento:* {{vencimento}} ({{dias_atraso}} dia(s) em atraso)",
    "💳 *Forma de pagamento:* {{forma_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "{{#encargos}}",
    "⚠️ *Encargos:* {{encargos}}",
    "{{/encargos}}",
    "{{#chave_pix}}",
    "🔑 *Chave PIX:* {{chave_pix}}",
    "{{/chave_pix}}",
    "{{#link_pagamento}}",
    "🔗 *Link para pagamento:* {{link_pagamento}}",
    "{{/link_pagamento}}",
    "{{#extras}}",
    "{{extras}}",
    "{{/extras}}",
    "",
    "Se já realizou o pagamento, por favor nos avise. 🙏",
  ].join("\n"),
  confirmacao_pagamento: [
    "✅ *Pagamento Confirmado*",
    "",
    "Olá, {{primeiro_nome}}! Recebemos a confirmação do seu pagamento:",
    "",
    "💰 *Valor pago:* {{valor_pago}}",
    "📅 *Data:* {{data_pagamento}}",
    "📝 *Descrição:* {{descricao}}",
    "",
    "Muito obrigado! 🙏",
  ].join("\n"),
  cancelamento: [
    "⚪ *Cobrança Cancelada*",
    "",
    "Olá, {{primeiro_nome}}. Esta cobrança foi cancelada:",
    "",
    "📝 *Descrição:* {{descricao}}",
    "📅 *Vencimento original:* {{vencimento}}",
    "",
    "Desconsidere esta cobrança. ✅",
  ].join("\n"),
};

function ensureNumber(value: any, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ensureMoney(value: any, fallback = 0) {
  return Math.round(ensureNumber(value, fallback) * 100) / 100;
}

function ensureBoolean(value: any) {
  if (typeof value === "boolean") return value;
  return Number(value || 0) === 1;
}

function onlyDigits(value: any) {
  return String(value ?? "").replace(/\D/g, "");
}

function cleanString(value: any) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function nullableString(value: any) {
  const text = cleanString(value);
  return text ?? null;
}

function nowMs() {
  return Date.now();
}

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function parseDateOnly(value: string) {
  if (!isDateOnly(value)) {
    throw new Error("Data inválida. Use o formato YYYY-MM-DD.");
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error("Data inválida.");
  }
  return date;
}

function formatDateOnly(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateOnly() {
  const now = new Date();
  return formatDateOnly(
    new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
  );
}

function addDays(dateStr: string, days: number) {
  const date = parseDateOnly(dateStr);
  date.setDate(date.getDate() + days);
  return formatDateOnly(date);
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0, 12, 0, 0, 0).getDate();
}

function addMonthsClamped(dateStr: string, months: number) {
  const base = parseDateOnly(dateStr);
  const day = base.getDate();
  const targetMonthIndex = base.getMonth() + months;
  const year = base.getFullYear() + Math.floor(targetMonthIndex / 12);
  const monthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(year, monthIndex));
  return formatDateOnly(new Date(year, monthIndex, clampedDay, 12, 0, 0, 0));
}

function diffDays(fromDate: string, toDate: string) {
  const from = parseDateOnly(fromDate).getTime();
  const to = parseDateOnly(toDate).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function formatCurrency(value: number) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateBr(value: string) {
  const date = parseDateOnly(value);
  return date.toLocaleDateString("pt-BR");
}

function formatTimestampBr(value?: number) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("pt-BR");
}

function firstName(name: string) {
  return String(name || "").trim().split(/\s+/)[0] || "cliente";
}

function normalizeTemplateValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function renderChargeTemplate(
  template: string,
  replacements: Record<string, unknown>
) {
  let rendered = String(template || "");

  rendered = rendered.replace(
    /{{#([a-zA-Z0-9_]+)}}([\s\S]*?){{\/\1}}/g,
    (_, key: string, content: string) => {
      const value = normalizeTemplateValue(replacements[key]).trim();
      return value ? content : "";
    }
  );

  rendered = rendered.replace(/{{([a-zA-Z0-9_]+)}}/g, (_, key: string) =>
    normalizeTemplateValue(replacements[key])
  );

  return rendered
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function loadUserChargePreferences(
  userId: number
): Promise<UserChargePreferences> {
  const db = getDB();
  const row = await db.get<UserChargePreferencesRow>(
    `
    SELECT
      default_session_name,
      template_cobranca_criacao,
      template_cobranca_lembrete,
      template_cobranca_atraso,
      template_cobranca_confirmacao,
      template_cobranca_cancelamento
    FROM users
    WHERE id = ?
    LIMIT 1
    `,
    [userId]
  );

  return {
    defaultSessionName: cleanString(row?.default_session_name),
    templates: {
      criacao: cleanString(row?.template_cobranca_criacao) || null,
      lembrete_vencimento: cleanString(row?.template_cobranca_lembrete) || null,
      atraso: cleanString(row?.template_cobranca_atraso) || null,
      confirmacao_pagamento:
        cleanString(row?.template_cobranca_confirmacao) || null,
      cancelamento: cleanString(row?.template_cobranca_cancelamento) || null,
    },
  };
}

function assertBillingType(value: any): BillingType {
  if (!BILLING_TYPES.includes(value as BillingType)) {
    throw new Error("Forma de pagamento inválida.");
  }
  return value as BillingType;
}

function assertCycleType(value: any): CycleType {
  if (!CYCLE_TYPES.includes(value as CycleType)) {
    throw new Error("Ciclo de recorrência inválido.");
  }
  return value as CycleType;
}

function normalizePhone(phone: any) {
  const digits = onlyDigits(phone);
  if (digits.length < 10 || digits.length > 15) {
    throw new Error(
      "Telefone inválido. Informe o número com DDI e DDD, usando apenas dígitos."
    );
  }
  return digits;
}

function calculateDiscountedValue(
  valor: number,
  descontoPercentual?: number,
  vencimento?: string,
  descontoLimiteDias?: number
) {
  const percentual = ensureNumber(descontoPercentual);
  const diasLimite = ensureNumber(descontoLimiteDias);
  if (!percentual || percentual <= 0 || !vencimento || diasLimite <= 0) {
    return null;
  }

  const hoje = todayDateOnly();
  const limite = addDays(vencimento, -diasLimite);
  if (hoje > limite) return null;

  return ensureMoney(valor * (1 - percentual / 100));
}

function calculateDiscountDeadline(
  vencimento?: string,
  descontoLimiteDias?: number
) {
  const diasLimite = ensureNumber(descontoLimiteDias);
  if (!vencimento || diasLimite <= 0) return null;
  return addDays(vencimento, -diasLimite);
}

function splitInstallments(total: number, parcelas: number) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / parcelas);
  const remainder = cents % parcelas;

  return Array.from({ length: parcelas }, (_, index) =>
    (base + (index < remainder ? 1 : 0)) / 100
  );
}

function mapCliente(row: ClienteRow): CobrancaCliente {
  return {
    id: ensureNumber(row.id),
    user_id: ensureNumber(row.user_id),
    nome: row.nome,
    telefone: row.telefone,
    email: row.email || undefined,
    cpf_cnpj: row.cpf_cnpj || undefined,
    observacoes: row.observacoes || undefined,
    created_at: ensureNumber(row.created_at),
  };
}

function mapCobranca(row: CobrancaRow): Cobranca {
  return {
    id: ensureNumber(row.id),
    user_id: ensureNumber(row.user_id),
    cliente_id: ensureNumber(row.cliente_id),
    cliente_nome: row.cliente_nome,
    cliente_telefone: row.cliente_telefone,
    billing_type: row.billing_type,
    valor: ensureMoney(row.valor),
    valor_pago: row.valor_pago == null ? undefined : ensureMoney(row.valor_pago),
    descricao: row.descricao,
    vencimento: row.vencimento,
    status: row.status,
    observacoes: row.observacoes || undefined,
    chave_pix: row.chave_pix || undefined,
    link_pagamento: row.link_pagamento || undefined,
    multa_percentual:
      row.multa_percentual == null
        ? undefined
        : ensureMoney(row.multa_percentual),
    juros_percentual:
      row.juros_percentual == null
        ? undefined
        : ensureMoney(row.juros_percentual),
    desconto_percentual:
      row.desconto_percentual == null
        ? undefined
        : ensureMoney(row.desconto_percentual),
    desconto_limite_dias:
      row.desconto_limite_dias == null
        ? undefined
        : ensureNumber(row.desconto_limite_dias),
    parcelas: row.parcelas == null ? undefined : ensureNumber(row.parcelas),
    parcela_atual:
      row.parcela_atual == null ? undefined : ensureNumber(row.parcela_atual),
    cobranca_pai_id:
      row.cobranca_pai_id == null ? undefined : ensureNumber(row.cobranca_pai_id),
    recorrente: ensureBoolean(row.recorrente),
    recorrencia_id:
      row.recorrencia_id == null ? undefined : ensureNumber(row.recorrencia_id),
    session_name: row.session_name || undefined,
    notificado_criacao: ensureBoolean(row.notificado_criacao),
    notificado_vencimento: ensureBoolean(row.notificado_vencimento),
    notificado_atraso: ensureBoolean(row.notificado_atraso),
    pago_em: row.pago_em == null ? undefined : ensureNumber(row.pago_em),
    created_at: ensureNumber(row.created_at),
    updated_at: ensureNumber(row.updated_at),
  };
}

function mapRecorrencia(row: RecorrenciaRow): Recorrencia {
  return {
    id: ensureNumber(row.id),
    user_id: ensureNumber(row.user_id),
    cliente_id: ensureNumber(row.cliente_id),
    cliente_nome: row.cliente_nome,
    billing_type: row.billing_type,
    cycle: row.cycle,
    valor: ensureMoney(row.valor),
    descricao: row.descricao,
    proxima_cobranca: row.proxima_cobranca,
    data_fim: row.data_fim || undefined,
    ativa: ensureBoolean(row.ativa),
    session_name: row.session_name || undefined,
    created_at: ensureNumber(row.created_at),
  };
}

async function getClienteById(
  db: DBClient,
  userId: number,
  clienteId: number
) {
  return db.get<ClienteRow>(
    `
    SELECT *
    FROM cobranca_clientes
    WHERE user_id = ? AND id = ?
    LIMIT 1
    `,
    [userId, clienteId]
  );
}

async function getCobrancaById(
  db: DBClient,
  userId: number,
  cobrancaId: number
) {
  return db.get<CobrancaRow>(
    `
    SELECT *
    FROM cobrancas
    WHERE user_id = ? AND id = ?
    LIMIT 1
    `,
    [userId, cobrancaId]
  );
}

async function getCobrancaByIdForUpdate(
  db: DBClient,
  userId: number,
  cobrancaId: number
) {
  return db.get<CobrancaRow>(
    `
    SELECT *
    FROM cobrancas
    WHERE user_id = ? AND id = ?
    LIMIT 1
    FOR UPDATE
    `,
    [userId, cobrancaId]
  );
}

async function insertCharge(
  db: DBClient,
  input: ChargeInsertInput
): Promise<Cobranca> {
  const timestamp = nowMs();
  const result = await db.run(
    `
    INSERT INTO cobrancas (
      user_id,
      cliente_id,
      cliente_nome,
      cliente_telefone,
      billing_type,
      valor,
      valor_pago,
      descricao,
      vencimento,
      status,
      observacoes,
      chave_pix,
      link_pagamento,
      multa_percentual,
      juros_percentual,
      desconto_percentual,
      desconto_limite_dias,
      parcelas,
      parcela_atual,
      cobranca_pai_id,
      recorrente,
      recorrencia_id,
      session_name,
      notificado_criacao,
      notificado_vencimento,
      notificado_atraso,
      pago_em,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.user_id,
      input.cliente_id,
      input.cliente_nome,
      input.cliente_telefone,
      input.billing_type,
      ensureMoney(input.valor),
      input.valor_pago == null ? null : ensureMoney(input.valor_pago),
      input.descricao,
      input.vencimento,
      input.status,
      nullableString(input.observacoes),
      nullableString(input.chave_pix),
      nullableString(input.link_pagamento),
      ensureMoney(input.multa_percentual),
      ensureMoney(input.juros_percentual),
      ensureMoney(input.desconto_percentual),
      ensureNumber(input.desconto_limite_dias),
      ensureNumber(input.parcelas || 1),
      ensureNumber(input.parcela_atual || 1),
      input.cobranca_pai_id ?? null,
      input.recorrente ? 1 : 0,
      input.recorrencia_id ?? null,
      nullableString(input.session_name),
      input.notificado_criacao ? 1 : 0,
      input.notificado_vencimento ? 1 : 0,
      input.notificado_atraso ? 1 : 0,
      input.pago_em ?? null,
      timestamp,
      timestamp,
    ]
  );

  const inserted = await db.get<CobrancaRow>(
    `SELECT * FROM cobrancas WHERE id = ? LIMIT 1`,
    [result.insertId]
  );

  if (!inserted) {
    throw new Error("Não foi possível carregar a cobrança criada.");
  }

  return mapCobranca(inserted);
}

async function syncParentCharge(db: DBClient, parentId: number) {
  const summary = await db.get<{
    total: number;
    pagos: number;
    cancelados: number;
    valor_pago: number | string | null;
  }>(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'PAGO' THEN 1 ELSE 0 END) AS pagos,
      SUM(CASE WHEN status = 'CANCELADO' THEN 1 ELSE 0 END) AS cancelados,
      SUM(CASE WHEN status = 'PAGO' THEN COALESCE(valor_pago, valor) ELSE 0 END) AS valor_pago
    FROM cobrancas
    WHERE cobranca_pai_id = ?
    `,
    [parentId]
  );

  if (!summary || !ensureNumber(summary.total)) return;

  let status: ChargeStatus = "PARCIAL";
  let pagoEm: number | null = null;

  if (ensureNumber(summary.pagos) === ensureNumber(summary.total)) {
    status = "PAGO";
    pagoEm = nowMs();
  } else if (
    ensureNumber(summary.cancelados) === ensureNumber(summary.total)
  ) {
    status = "CANCELADO";
  }

  await db.run(
    `
    UPDATE cobrancas
    SET status = ?, valor_pago = ?, pago_em = ?, updated_at = ?
    WHERE id = ?
    `,
    [
      status,
      ensureMoney(summary.valor_pago),
      pagoEm,
      nowMs(),
      parentId,
    ]
  );
}

async function upsertClienteInternal(
  db: DBClient,
  userId: number,
  data: {
    nome: string;
    telefone: string;
    email?: string;
    cpf_cnpj?: string;
    observacoes?: string;
  },
  clienteId?: number
): Promise<CobrancaCliente> {
  const nome = cleanString(data.nome);
  const telefone = normalizePhone(data.telefone);

  if (!nome) {
    throw new Error("Nome do cliente é obrigatório.");
  }

  const timestamp = nowMs();
  const email = cleanString(data.email);
  const cpfCnpj = cleanString(data.cpf_cnpj);
  const observacoes = cleanString(data.observacoes);

  if (clienteId) {
    const existing = await getClienteById(db, userId, clienteId);
    if (!existing) {
      throw new Error("Cliente não encontrado.");
    }

    const duplicate = await db.get<{ id: number }>(
      `
      SELECT id
      FROM cobranca_clientes
      WHERE user_id = ? AND telefone = ? AND id <> ?
      LIMIT 1
      `,
      [userId, telefone, clienteId]
    );

    if (duplicate) {
      throw new Error("Já existe outro cliente com este telefone.");
    }

    await db.run(
      `
      UPDATE cobranca_clientes
      SET nome = ?, telefone = ?, email = ?, cpf_cnpj = ?, observacoes = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
      `,
      [
        nome,
        telefone,
        email ?? existing.email,
        cpfCnpj ?? existing.cpf_cnpj,
        observacoes ?? existing.observacoes,
        timestamp,
        clienteId,
        userId,
      ]
    );

    const updated = await getClienteById(db, userId, clienteId);
    if (!updated) {
      throw new Error("Não foi possível carregar o cliente atualizado.");
    }
    return mapCliente(updated);
  }

  const existingByPhone = await db.get<ClienteRow>(
    `
    SELECT *
    FROM cobranca_clientes
    WHERE user_id = ? AND telefone = ?
    LIMIT 1
    `,
    [userId, telefone]
  );

  if (existingByPhone) {
    await db.run(
      `
      UPDATE cobranca_clientes
      SET nome = ?, email = ?, cpf_cnpj = ?, observacoes = ?, updated_at = ?
      WHERE id = ?
      `,
      [
        nome,
        email ?? existingByPhone.email,
        cpfCnpj ?? existingByPhone.cpf_cnpj,
        observacoes ?? existingByPhone.observacoes,
        timestamp,
        existingByPhone.id,
      ]
    );

    const updated = await getClienteById(db, userId, existingByPhone.id);
    if (!updated) {
      throw new Error("Não foi possível carregar o cliente atualizado.");
    }
    return mapCliente(updated);
  }

  const result = await db.run(
    `
    INSERT INTO cobranca_clientes (
      user_id,
      nome,
      telefone,
      email,
      cpf_cnpj,
      observacoes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      userId,
      nome,
      telefone,
      email ?? null,
      cpfCnpj ?? null,
      observacoes ?? null,
      timestamp,
      timestamp,
    ]
  );

  const created = await getClienteById(db, userId, result.insertId);
  if (!created) {
    throw new Error("Não foi possível carregar o cliente criado.");
  }
  return mapCliente(created);
}

async function resolveClienteForCharge(
  db: DBClient,
  input: CreateCobrancaInput
) {
  return upsertClienteInternal(
    db,
    input.user_id,
    {
      nome: input.nome,
      telefone: input.telefone,
      email: input.email,
      cpf_cnpj: input.cpf_cnpj,
    },
    input.cliente_id
  );
}

async function getRecorrenciaForUpdate(
  db: DBClient,
  userId: number,
  recorrenciaId: number
) {
  return db.get<RecorrenciaRow>(
    `
    SELECT *
    FROM cobrancas_recorrencias
    WHERE user_id = ? AND id = ?
    LIMIT 1
    FOR UPDATE
    `,
    [userId, recorrenciaId]
  );
}

async function createNextRecurringChargeIfNeeded(
  db: DBClient,
  currentCharge: Cobranca
) {
  if (!currentCharge.recorrente || !currentCharge.recorrencia_id) return;

  const recurrence = await getRecorrenciaForUpdate(
    db,
    currentCharge.user_id,
    currentCharge.recorrencia_id
  );

  if (!recurrence || !ensureBoolean(recurrence.ativa)) return;

  const nextDueDate = recurrence.proxima_cobranca;
  if (!isDateOnly(nextDueDate)) return;

  const dataFim = recurrence.data_fim || undefined;
  if (dataFim && nextDueDate > dataFim) {
    await db.run(
      `
      UPDATE cobrancas_recorrencias
      SET ativa = 0, updated_at = ?
      WHERE id = ?
      `,
      [nowMs(), recurrence.id]
    );
    return;
  }

  const existingNext = await db.get<{ id: number }>(
    `
    SELECT id
    FROM cobrancas
    WHERE user_id = ? AND recorrencia_id = ? AND vencimento = ?
    LIMIT 1
    `,
    [currentCharge.user_id, recurrence.id, nextDueDate]
  );

  if (!existingNext) {
    await insertCharge(db, {
      user_id: currentCharge.user_id,
      cliente_id: currentCharge.cliente_id,
      cliente_nome: recurrence.cliente_nome || currentCharge.cliente_nome,
      cliente_telefone: currentCharge.cliente_telefone,
      billing_type: recurrence.billing_type || currentCharge.billing_type,
      valor: ensureMoney(recurrence.valor || currentCharge.valor),
      descricao: recurrence.descricao || currentCharge.descricao,
      vencimento: nextDueDate,
      status: "PENDENTE",
      observacoes: currentCharge.observacoes,
      chave_pix: currentCharge.chave_pix,
      link_pagamento: currentCharge.link_pagamento,
      multa_percentual: currentCharge.multa_percentual,
      juros_percentual: currentCharge.juros_percentual,
      desconto_percentual: currentCharge.desconto_percentual,
      desconto_limite_dias: currentCharge.desconto_limite_dias,
      parcelas: 1,
      parcela_atual: 1,
      recorrente: true,
      recorrencia_id: recurrence.id,
      session_name: recurrence.session_name || currentCharge.session_name,
    });
  }

  const upcomingDate = await calcularProximaData(nextDueDate, recurrence.cycle);
  const remainActive = !dataFim || upcomingDate <= dataFim;

  await db.run(
    `
    UPDATE cobrancas_recorrencias
    SET proxima_cobranca = ?, ativa = ?, updated_at = ?
    WHERE id = ?
    `,
    [upcomingDate, remainActive ? 1 : 0, nowMs(), recurrence.id]
  );
}

async function listConnectedSessionNames(userId: number) {
  const db = getDB();
  const rows = await db.all<{ session_name: string }>(
    `
    SELECT session_name
    FROM sessions
    WHERE user_id = ? AND status = 'connected'
    ORDER BY created_at DESC, id DESC
    `,
    [userId]
  );

  return rows
    .map((row) => cleanString(row.session_name))
    .filter(Boolean) as string[];
}

async function resolveNotificationClient(
  userId: number,
  preferredSessionName?: string
) {
  const userPreferences = await loadUserChargePreferences(userId);
  const sessions = await listConnectedSessionNames(userId);
  const preferred =
    cleanString(preferredSessionName) || userPreferences.defaultSessionName;
  const ordered = preferred
    ? [preferred, ...sessions.filter((session) => session !== preferred)]
    : sessions;

  for (const sessionName of ordered) {
    const client = getClient(`USER${userId}_${sessionName}`);
    if (client) {
      return {
        client,
        sessionName,
      };
    }
  }

  return null;
}

function buildChargeExtras(cobranca: Cobranca) {
  const lines: string[] = [];

  const discountedValue = calculateDiscountedValue(
    cobranca.valor,
    cobranca.desconto_percentual,
    cobranca.vencimento,
    cobranca.desconto_limite_dias
  );
  const discountDeadline = calculateDiscountDeadline(
    cobranca.vencimento,
    cobranca.desconto_limite_dias
  );

  if (discountedValue != null && discountDeadline) {
    lines.push(
      `🏷️ *Pagamento com desconto até ${formatDateBr(discountDeadline)}:* ${formatCurrency(
        discountedValue
      )}`
    );
  }

  if (cobranca.billing_type === "PIX" && cobranca.chave_pix) {
    lines.push(`🔑 *Chave PIX:* ${cobranca.chave_pix}`);
  }

  if (cobranca.link_pagamento) {
    lines.push(`🔗 *Link para pagamento:* ${cobranca.link_pagamento}`);
  }

  if (ensureNumber(cobranca.parcelas) > 1 && ensureNumber(cobranca.parcela_atual) > 0) {
    lines.push(
      `🧾 *Parcela:* ${ensureNumber(cobranca.parcela_atual)}/${ensureNumber(
        cobranca.parcelas
      )}`
    );
  }

  return lines;
}

function buildBillingTypeLabel(type: BillingType) {
  const map: Record<BillingType, string> = {
    PIX: "PIX",
    BOLETO: "Boleto / Depósito",
    CARTAO: "Cartão",
    TRANSFERENCIA: "Transferência",
    DINHEIRO: "Dinheiro",
    OUTRO: "Outro",
  };
  return map[type] || type;
}

export async function criarOuBuscarCliente(
  userId: number,
  data: {
    nome: string;
    telefone: string;
    email?: string;
    cpf_cnpj?: string;
    observacoes?: string;
  }
): Promise<CobrancaCliente> {
  const db = getDB();
  return upsertClienteInternal(db, userId, data);
}

export async function listarClientes(
  userId: number,
  search?: string
): Promise<CobrancaCliente[]> {
  const db = getDB();
  const term = cleanString(search);
  const params: any[] = [userId];
  let where = `WHERE user_id = ?`;

  if (term) {
    const like = `%${term}%`;
    where += ` AND (nome LIKE ? OR telefone LIKE ? OR cpf_cnpj LIKE ?)`;
    params.push(like, like, like);
  }

  const rows = await db.all<ClienteRow>(
    `
    SELECT *
    FROM cobranca_clientes
    ${where}
    ORDER BY nome ASC, id ASC
    `,
    params
  );

  return rows.map(mapCliente);
}

export async function editarCliente(
  userId: number,
  clienteId: number,
  data: Partial<CobrancaCliente>
): Promise<void> {
  const db = getDB();
  const existing = await getClienteById(db, userId, clienteId);
  if (!existing) {
    throw new Error("Cliente não encontrado.");
  }

  const nome = cleanString(data.nome) ?? existing.nome;
  const telefone =
    data.telefone != null ? normalizePhone(data.telefone) : existing.telefone;

  if (!nome) {
    throw new Error("Nome do cliente é obrigatório.");
  }

  const duplicate = await db.get<{ id: number }>(
    `
    SELECT id
    FROM cobranca_clientes
    WHERE user_id = ? AND telefone = ? AND id <> ?
    LIMIT 1
    `,
    [userId, telefone, clienteId]
  );

  if (duplicate) {
    throw new Error("Já existe outro cliente com este telefone.");
  }

  await db.run(
    `
    UPDATE cobranca_clientes
    SET nome = ?, telefone = ?, email = ?, cpf_cnpj = ?, observacoes = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [
      nome,
      telefone,
      data.email !== undefined ? nullableString(data.email) : existing.email,
      data.cpf_cnpj !== undefined
        ? nullableString(data.cpf_cnpj)
        : existing.cpf_cnpj,
      data.observacoes !== undefined
        ? nullableString(data.observacoes)
        : existing.observacoes,
      nowMs(),
      userId,
      clienteId,
    ]
  );

  await db.run(
    `
    UPDATE cobrancas
    SET cliente_nome = ?, cliente_telefone = ?, updated_at = ?
    WHERE user_id = ? AND cliente_id = ?
    `,
    [nome, telefone, nowMs(), userId, clienteId]
  );

  await db.run(
    `
    UPDATE cobrancas_recorrencias
    SET cliente_nome = ?, updated_at = ?
    WHERE user_id = ? AND cliente_id = ?
    `,
    [nome, nowMs(), userId, clienteId]
  );
}

export async function deletarCliente(
  userId: number,
  clienteId: number
): Promise<void> {
  const db = getDB();
  const existing = await getClienteById(db, userId, clienteId);
  if (!existing) {
    throw new Error("Cliente não encontrado.");
  }

  const activeCharges = await db.get<{ total: number }>(
    `
    SELECT COUNT(*) AS total
    FROM cobrancas
    WHERE user_id = ?
      AND cliente_id = ?
      AND status IN ('PENDENTE', 'VENCIDO', 'PARCIAL')
    `,
    [userId, clienteId]
  );

  if (ensureNumber(activeCharges?.total) > 0) {
    throw new Error("Possui cobranças ativas");
  }

  const activeRecurrences = await db.get<{ total: number }>(
    `
    SELECT COUNT(*) AS total
    FROM cobrancas_recorrencias
    WHERE user_id = ? AND cliente_id = ? AND ativa = 1
    `,
    [userId, clienteId]
  );

  if (ensureNumber(activeRecurrences?.total) > 0) {
    throw new Error("Possui recorrências ativas");
  }

  await db.run(
    `
    DELETE FROM cobranca_clientes
    WHERE user_id = ? AND id = ?
    `,
    [userId, clienteId]
  );
}

export async function criarCobranca(
  input: CreateCobrancaInput
): Promise<{ cobranca: Cobranca; parcelamentos?: Cobranca[] }> {
  return withDBTransaction(async (db) => {
    if (!Number.isFinite(Number(input.user_id))) {
      throw new Error("Usuário inválido.");
    }

    const userPreferences = await loadUserChargePreferences(input.user_id);
    const billingType = assertBillingType(input.billing_type);
    const valor = ensureMoney(input.valor);
    const parcelas = Math.max(1, Math.floor(ensureNumber(input.parcelas || 1, 1)));
    const recorrente = Boolean(input.recorrente);
    const descricao = cleanString(input.descricao);
    const vencimento = cleanString(input.vencimento);
    const sessionName =
      cleanString(input.session_name) || userPreferences.defaultSessionName;
    const dataFim = cleanString(input.data_fim);

    if (!descricao) {
      throw new Error("Descrição da cobrança é obrigatória.");
    }

    if (!vencimento || !isDateOnly(vencimento)) {
      throw new Error("Vencimento inválido.");
    }

    parseDateOnly(vencimento);

    if (valor <= 0) {
      throw new Error("Valor da cobrança deve ser maior que zero.");
    }

    if (recorrente && parcelas > 1) {
      throw new Error("Cobranças recorrentes não podem ser parceladas.");
    }

    let cycle: CycleType | undefined;
    if (recorrente) {
      cycle = assertCycleType(input.cycle);
    }

    if (dataFim) {
      parseDateOnly(dataFim);
      if (dataFim < vencimento) {
        throw new Error("A data de encerramento não pode ser menor que o vencimento inicial.");
      }
    }

    const cliente = await resolveClienteForCharge(db, input);
    const descontoPercentual = ensureMoney(input.desconto_percentual);
    const descontoLimiteDias = Math.max(
      0,
      Math.floor(ensureNumber(input.desconto_limite_dias))
    );

    calculateDiscountedValue(
      valor,
      descontoPercentual,
      vencimento,
      descontoLimiteDias
    );

    let recorrenciaId: number | undefined;

    if (recorrente && cycle) {
      const timestamp = nowMs();
      const primeiraProximaData = await calcularProximaData(vencimento, cycle);
      const recurrenceResult = await db.run(
        `
        INSERT INTO cobrancas_recorrencias (
          user_id,
          cliente_id,
          cliente_nome,
          billing_type,
          cycle,
          valor,
          descricao,
          proxima_cobranca,
          data_fim,
          ativa,
          session_name,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          input.user_id,
          cliente.id,
          cliente.nome,
          billingType,
          cycle,
          valor,
          descricao,
          primeiraProximaData,
          dataFim ?? null,
          1,
          sessionName ?? null,
          timestamp,
          timestamp,
        ]
      );
      recorrenciaId = ensureNumber(recurrenceResult.insertId);
    }

    const commonChargeInput = {
      user_id: input.user_id,
      cliente_id: cliente.id,
      cliente_nome: cliente.nome,
      cliente_telefone: cliente.telefone,
      billing_type: billingType,
      descricao,
      observacoes: cleanString(input.observacoes),
      chave_pix: cleanString(input.chave_pix),
      link_pagamento: cleanString(input.link_pagamento),
      multa_percentual: ensureMoney(input.multa_percentual),
      juros_percentual: ensureMoney(input.juros_percentual),
      desconto_percentual: descontoPercentual,
      desconto_limite_dias: descontoLimiteDias,
      session_name: sessionName,
    };

    if (parcelas > 1) {
      const parent = await insertCharge(db, {
        ...commonChargeInput,
        valor,
        vencimento,
        status: "PARCIAL",
        parcelas,
        parcela_atual: 0,
        recorrente: false,
      });

      const installmentValues = splitInstallments(valor, parcelas);
      const parcelamentos: Cobranca[] = [];

      for (let index = 0; index < parcelas; index += 1) {
        const parcela = await insertCharge(db, {
          ...commonChargeInput,
          valor: installmentValues[index],
          vencimento: addMonthsClamped(vencimento, index),
          status: "PENDENTE",
          parcelas,
          parcela_atual: index + 1,
          cobranca_pai_id: parent.id,
          recorrente: false,
        });
        parcelamentos.push(parcela);
      }

      return {
        cobranca: parcelamentos[0],
        parcelamentos,
      };
    }

    const cobranca = await insertCharge(db, {
      ...commonChargeInput,
      valor,
      vencimento,
      status: "PENDENTE",
      parcelas: 1,
      parcela_atual: 1,
      recorrente,
      recorrencia_id: recorrenciaId,
    });

    return { cobranca };
  });
}

export async function listarCobrancas(
  userId: number,
  filters: {
    status?: ChargeStatus | "all";
    search?: string;
    from?: string;
    to?: string;
    cliente_id?: number;
    recorrencia_id?: number;
    page?: number;
    pageSize?: number;
  }
): Promise<{ charges: Cobranca[]; total: number; pages: number }> {
  const db = getDB();
  const params: any[] = [userId];
  const countParams: any[] = [userId];
  const whereParts = [`c.user_id = ?`];

  const status = cleanString(filters.status);
  if (status && status !== "all") {
    whereParts.push(`c.status = ?`);
    params.push(status);
    countParams.push(status);
  } else {
    whereParts.push(`NOT (c.status = 'PARCIAL' AND c.cobranca_pai_id IS NULL)`);
  }

  const search = cleanString(filters.search);
  if (search) {
    const like = `%${search}%`;
    whereParts.push(
      `(c.cliente_nome LIKE ? OR c.cliente_telefone LIKE ? OR c.descricao LIKE ? OR cc.cpf_cnpj LIKE ?)`
    );
    params.push(like, like, like, like);
    countParams.push(like, like, like, like);
  }

  const from = cleanString(filters.from);
  if (from) {
    parseDateOnly(from);
    whereParts.push(`c.vencimento >= ?`);
    params.push(from);
    countParams.push(from);
  }

  const to = cleanString(filters.to);
  if (to) {
    parseDateOnly(to);
    whereParts.push(`c.vencimento <= ?`);
    params.push(to);
    countParams.push(to);
  }

  if (filters.cliente_id) {
    whereParts.push(`c.cliente_id = ?`);
    params.push(filters.cliente_id);
    countParams.push(filters.cliente_id);
  }

  if (filters.recorrencia_id) {
    whereParts.push(`c.recorrencia_id = ?`);
    params.push(filters.recorrencia_id);
    countParams.push(filters.recorrencia_id);
  }

  const page = Math.max(1, Math.floor(ensureNumber(filters.page || 1, 1)));
  const pageSize = Math.max(
    1,
    Math.min(100, Math.floor(ensureNumber(filters.pageSize || 20, 20)))
  );
  const offset = (page - 1) * pageSize;

  const whereSql = whereParts.join(" AND ");

  const totalRow = await db.get<{ total: number }>(
    `
    SELECT COUNT(*) AS total
    FROM cobrancas c
    LEFT JOIN cobranca_clientes cc ON cc.id = c.cliente_id
    WHERE ${whereSql}
    `,
    countParams
  );

  const rows = await db.all<CobrancaRow>(
    `
    SELECT c.*
    FROM cobrancas c
    LEFT JOIN cobranca_clientes cc ON cc.id = c.cliente_id
    WHERE ${whereSql}
    ORDER BY
      CASE c.status
        WHEN 'VENCIDO' THEN 1
        WHEN 'PENDENTE' THEN 2
        WHEN 'PARCIAL' THEN 3
        WHEN 'PAGO' THEN 4
        WHEN 'CANCELADO' THEN 5
        ELSE 6
      END ASC,
      c.vencimento ASC,
      c.id DESC
    LIMIT ? OFFSET ?
    `,
    [...params, pageSize, offset]
  );

  const total = ensureNumber(totalRow?.total);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return {
    charges: rows.map(mapCobranca),
    total,
    pages,
  };
}

export async function buscarCobranca(
  userId: number,
  cobrancaId: number
): Promise<Cobranca | null> {
  const db = getDB();
  const row = await getCobrancaById(db, userId, cobrancaId);
  return row ? mapCobranca(row) : null;
}

export async function marcarComoPago(
  userId: number,
  cobrancaId: number,
  valorPago?: number,
  pagoEm?: string
): Promise<Cobranca> {
  return withDBTransaction(async (db) => {
    const currentRow = await getCobrancaByIdForUpdate(db, userId, cobrancaId);
    if (!currentRow) {
      throw new Error("Cobrança não encontrada.");
    }

    const current = mapCobranca(currentRow);

    if (current.status === "PAGO") {
      return current;
    }

    if (current.status === "CANCELADO") {
      throw new Error("Cobrança cancelada não pode ser marcada como paga.");
    }

    if (current.status === "PARCIAL" && !current.cobranca_pai_id) {
      throw new Error("Marque as parcelas individualmente como pagas.");
    }

    const paidValue =
      valorPago != null && Number.isFinite(Number(valorPago))
        ? ensureMoney(valorPago)
        : current.valor;

    if (paidValue <= 0) {
      throw new Error("Valor pago inválido.");
    }

    const paidAt = pagoEm ? parseDateOnly(pagoEm).getTime() : nowMs();

    await db.run(
      `
      UPDATE cobrancas
      SET status = 'PAGO', valor_pago = ?, pago_em = ?, updated_at = ?
      WHERE user_id = ? AND id = ?
      `,
      [paidValue, paidAt, nowMs(), userId, cobrancaId]
    );

    if (current.cobranca_pai_id) {
      await syncParentCharge(db, current.cobranca_pai_id);
    }

    await createNextRecurringChargeIfNeeded(db, {
      ...current,
      valor_pago: paidValue,
      pago_em: paidAt,
      status: "PAGO",
    });

    const updated = await getCobrancaById(db, userId, cobrancaId);
    if (!updated) {
      throw new Error("Não foi possível carregar a cobrança paga.");
    }

    return mapCobranca(updated);
  });
}

export async function cancelarCobranca(
  userId: number,
  cobrancaId: number
): Promise<void> {
  await withDBTransaction(async (db) => {
    const row = await getCobrancaByIdForUpdate(db, userId, cobrancaId);
    if (!row) {
      throw new Error("Cobrança não encontrada.");
    }

    const current = mapCobranca(row);

    if (current.status === "PAGO") {
      throw new Error("Cobrança paga não pode ser cancelada.");
    }

    if (current.status === "CANCELADO") {
      return;
    }

    const timestamp = nowMs();

    if (current.status === "PARCIAL" && !current.cobranca_pai_id) {
      await db.run(
        `
        UPDATE cobrancas
        SET status = 'CANCELADO', updated_at = ?
        WHERE user_id = ? AND cobranca_pai_id = ? AND status IN ('PENDENTE', 'VENCIDO', 'PARCIAL')
        `,
        [timestamp, userId, current.id]
      );
    }

    await db.run(
      `
      UPDATE cobrancas
      SET status = 'CANCELADO', updated_at = ?
      WHERE user_id = ? AND id = ?
      `,
      [timestamp, userId, cobrancaId]
    );

    if (current.cobranca_pai_id) {
      await syncParentCharge(db, current.cobranca_pai_id);
    }
  });
}

export async function editarCobranca(
  userId: number,
  cobrancaId: number,
  data: Partial<Cobranca>
): Promise<void> {
  const db = getDB();
  const existing = await getCobrancaById(db, userId, cobrancaId);
  if (!existing) {
    throw new Error("Cobrança não encontrada.");
  }

  const charge = mapCobranca(existing);
  if (charge.status !== "PENDENTE") {
    throw new Error("Somente cobranças pendentes podem ser editadas.");
  }

  const billingType =
    data.billing_type != null
      ? assertBillingType(data.billing_type)
      : charge.billing_type;
  const valor =
    data.valor != null ? ensureMoney(data.valor) : ensureMoney(charge.valor);
  const descricao =
    data.descricao != null ? cleanString(data.descricao) : charge.descricao;
  const vencimento =
    data.vencimento != null ? cleanString(data.vencimento) : charge.vencimento;

  if (!descricao) {
    throw new Error("Descrição da cobrança é obrigatória.");
  }

  if (!vencimento || !isDateOnly(vencimento)) {
    throw new Error("Vencimento inválido.");
  }

  parseDateOnly(vencimento);

  if (valor <= 0) {
    throw new Error("Valor da cobrança deve ser maior que zero.");
  }

  await db.run(
    `
    UPDATE cobrancas
    SET
      billing_type = ?,
      valor = ?,
      descricao = ?,
      vencimento = ?,
      observacoes = ?,
      chave_pix = ?,
      link_pagamento = ?,
      multa_percentual = ?,
      juros_percentual = ?,
      desconto_percentual = ?,
      desconto_limite_dias = ?,
      session_name = ?,
      updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [
      billingType,
      valor,
      descricao,
      vencimento,
      data.observacoes !== undefined
        ? nullableString(data.observacoes)
        : existing.observacoes,
      data.chave_pix !== undefined
        ? nullableString(data.chave_pix)
        : existing.chave_pix,
      data.link_pagamento !== undefined
        ? nullableString(data.link_pagamento)
        : existing.link_pagamento,
      data.multa_percentual !== undefined
        ? ensureMoney(data.multa_percentual)
        : ensureMoney(existing.multa_percentual),
      data.juros_percentual !== undefined
        ? ensureMoney(data.juros_percentual)
        : ensureMoney(existing.juros_percentual),
      data.desconto_percentual !== undefined
        ? ensureMoney(data.desconto_percentual)
        : ensureMoney(existing.desconto_percentual),
      data.desconto_limite_dias !== undefined
        ? Math.max(0, Math.floor(ensureNumber(data.desconto_limite_dias)))
        : ensureNumber(existing.desconto_limite_dias),
      data.session_name !== undefined
        ? nullableString(data.session_name)
        : existing.session_name,
      nowMs(),
      userId,
      cobrancaId,
    ]
  );

  if (charge.recorrente && charge.recorrencia_id) {
    await db.run(
      `
      UPDATE cobrancas_recorrencias
      SET
        cliente_nome = ?,
        billing_type = ?,
        valor = ?,
        descricao = ?,
        session_name = ?,
        updated_at = ?
      WHERE user_id = ? AND id = ?
      `,
      [
        charge.cliente_nome,
        billingType,
        valor,
        descricao,
        data.session_name !== undefined
          ? nullableString(data.session_name)
          : existing.session_name,
        nowMs(),
        userId,
        charge.recorrencia_id,
      ]
    );
  }
}

export async function verificarEAtualizarVencidos(): Promise<void> {
  const db = getDB();
  await db.run(
    `
    UPDATE cobrancas
    SET status = 'VENCIDO', updated_at = ?
    WHERE status = 'PENDENTE'
      AND vencimento < CURDATE()
    `,
    [nowMs()]
  );
}

export async function getSummary(userId: number): Promise<CobrancaSummary> {
  const db = getDB();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const nextMonthStart = new Date(monthStart);
  nextMonthStart.setMonth(nextMonthStart.getMonth() + 1);

  const row = await db.get<{
    total_pendente: number;
    total_pago: number;
    total_vencido: number;
    total_cancelado: number;
    valor_pendente: number | string | null;
    valor_pago_mes: number | string | null;
    valor_vencido: number | string | null;
    total_clientes: number;
    total_recorrencias_ativas: number;
  }>(
    `
    SELECT
      SUM(CASE WHEN c.status = 'PENDENTE' THEN 1 ELSE 0 END) AS total_pendente,
      SUM(CASE WHEN c.status = 'PAGO' THEN 1 ELSE 0 END) AS total_pago,
      SUM(CASE WHEN c.status = 'VENCIDO' THEN 1 ELSE 0 END) AS total_vencido,
      SUM(CASE WHEN c.status = 'CANCELADO' THEN 1 ELSE 0 END) AS total_cancelado,
      SUM(CASE WHEN c.status = 'PENDENTE' THEN c.valor ELSE 0 END) AS valor_pendente,
      SUM(
        CASE
          WHEN c.status = 'PAGO'
           AND c.pago_em >= ?
           AND c.pago_em < ?
          THEN COALESCE(c.valor_pago, c.valor)
          ELSE 0
        END
      ) AS valor_pago_mes,
      SUM(CASE WHEN c.status = 'VENCIDO' THEN c.valor ELSE 0 END) AS valor_vencido,
      (
        SELECT COUNT(*)
        FROM cobranca_clientes cc
        WHERE cc.user_id = ?
      ) AS total_clientes,
      (
        SELECT COUNT(*)
        FROM cobrancas_recorrencias cr
        WHERE cr.user_id = ? AND cr.ativa = 1
      ) AS total_recorrencias_ativas
    FROM (SELECT ? AS user_id) base
    LEFT JOIN cobrancas c
      ON c.user_id = base.user_id
     AND NOT (c.status = 'PARCIAL' AND c.cobranca_pai_id IS NULL)
    `,
    [
      monthStart.getTime(),
      nextMonthStart.getTime(),
      userId,
      userId,
      userId,
    ]
  );

  return {
    total_pendente: ensureNumber(row?.total_pendente),
    total_pago: ensureNumber(row?.total_pago),
    total_vencido: ensureNumber(row?.total_vencido),
    total_cancelado: ensureNumber(row?.total_cancelado),
    valor_pendente: ensureMoney(row?.valor_pendente),
    valor_pago_mes: ensureMoney(row?.valor_pago_mes),
    valor_vencido: ensureMoney(row?.valor_vencido),
    total_clientes: ensureNumber(row?.total_clientes),
    total_recorrencias_ativas: ensureNumber(row?.total_recorrencias_ativas),
  };
}

export async function listarRecorrencias(
  userId: number
): Promise<Recorrencia[]> {
  const db = getDB();
  const rows = await db.all<RecorrenciaRow>(
    `
    SELECT *
    FROM cobrancas_recorrencias
    WHERE user_id = ?
    ORDER BY ativa DESC, proxima_cobranca ASC, id DESC
    `,
    [userId]
  );

  return rows.map(mapRecorrencia);
}

export async function pausarRecorrencia(
  userId: number,
  recorrenciaId: number
): Promise<void> {
  const db = getDB();
  const result = await db.run(
    `
    UPDATE cobrancas_recorrencias
    SET ativa = 0, updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [nowMs(), userId, recorrenciaId]
  );

  if (!result.affectedRows) {
    throw new Error("Recorrência não encontrada.");
  }
}

export async function reativarRecorrencia(
  userId: number,
  recorrenciaId: number
): Promise<void> {
  const db = getDB();
  const recurrence = await db.get<RecorrenciaRow>(
    `
    SELECT *
    FROM cobrancas_recorrencias
    WHERE user_id = ? AND id = ?
    LIMIT 1
    `,
    [userId, recorrenciaId]
  );

  if (!recurrence) {
    throw new Error("Recorrência não encontrada.");
  }

  if (recurrence.data_fim && recurrence.proxima_cobranca > recurrence.data_fim) {
    throw new Error("A recorrência já atingiu a data final configurada.");
  }

  await db.run(
    `
    UPDATE cobrancas_recorrencias
    SET ativa = 1, updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [nowMs(), userId, recorrenciaId]
  );
}

export async function calcularProximaData(
  dataBase: string,
  cycle: CycleType
): Promise<string> {
  parseDateOnly(dataBase);

  switch (cycle) {
    case "SEMANAL":
      return addDays(dataBase, 7);
    case "QUINZENAL":
      return addDays(dataBase, 14);
    case "MENSAL":
      return addMonthsClamped(dataBase, 1);
    case "TRIMESTRAL":
      return addMonthsClamped(dataBase, 3);
    case "SEMESTRAL":
      return addMonthsClamped(dataBase, 6);
    case "ANUAL":
      return addMonthsClamped(dataBase, 12);
    default:
      throw new Error("Ciclo de recorrência inválido.");
  }
}

export function buildMensagemCobranca(
  cobranca: Cobranca,
  tipo: ChargeMessageType,
  templates?: Partial<ChargeMessageTemplates>
): string {
  const nome = firstName(cobranca.cliente_nome);
  const valorPago = ensureMoney(cobranca.valor_pago ?? cobranca.valor);
  const extras = buildChargeExtras(cobranca);
  const extrasBlock = extras.length ? `\n${extras.join("\n")}\n` : "\n";
  const dias = diffDays(todayDateOnly(), cobranca.vencimento);
  const quandoVence =
    dias <= 0 ? "hoje" : dias === 1 ? "amanhã" : `em ${dias} dias`;
  const diasAtraso = Math.max(1, diffDays(cobranca.vencimento, todayDateOnly()));
  const encargos: string[] = [];

  if (ensureNumber(cobranca.multa_percentual) > 0) {
    encargos.push(`Multa: ${ensureMoney(cobranca.multa_percentual)}%`);
  }
  if (ensureNumber(cobranca.juros_percentual) > 0) {
    encargos.push(`Juros: ${ensureMoney(cobranca.juros_percentual)}% ao mês`);
  }

  const template =
    cleanString(templates?.[tipo]) || DEFAULT_CHARGE_MESSAGE_TEMPLATES[tipo];

  return renderChargeTemplate(template, {
    nome: cobranca.cliente_nome,
    primeiro_nome: nome,
    valor: formatCurrency(cobranca.valor),
    valor_pago: formatCurrency(valorPago),
    vencimento: formatDateBr(cobranca.vencimento),
    data_pagamento: formatTimestampBr(cobranca.pago_em),
    forma_pagamento: buildBillingTypeLabel(cobranca.billing_type),
    descricao: cobranca.descricao,
    observacoes: cobranca.observacoes || "",
    chave_pix: cobranca.chave_pix || "",
    link_pagamento: cobranca.link_pagamento || "",
    quando_vence: quandoVence,
    dias_atraso: diasAtraso,
    encargos: encargos.join(" | "),
    extras: extras.join("\n"),
  });

  if (tipo === "criacao") {
    return [
      "📋 *Nova Cobrança*",
      "",
      `Olá, ${nome}! 👋`,
      "Você tem uma cobrança pendente:",
      "",
      `💰 *Valor:* ${formatCurrency(cobranca.valor)}`,
      `📅 *Vencimento:* ${formatDateBr(cobranca.vencimento)}`,
      `💳 *Forma de pagamento:* ${buildBillingTypeLabel(cobranca.billing_type)}`,
      `📝 *Descrição:* ${cobranca.descricao}`,
      extrasBlock.trimEnd(),
      "",
      "Qualquer dúvida, estamos à disposição! ✅",
    ].join("\n");
  }

  if (tipo === "lembrete_vencimento") {
    const dias = diffDays(todayDateOnly(), cobranca.vencimento);
    const quando =
      dias <= 0 ? "hoje" : dias === 1 ? "amanhã" : `em ${dias} dias`;

    return [
      "⏰ *Lembrete de Vencimento*",
      "",
      `Olá, ${nome}! Sua cobrança vence ${quando}:`,
      "",
      `💰 *Valor:* ${formatCurrency(cobranca.valor)}`,
      `📅 *Vencimento:* ${formatDateBr(cobranca.vencimento)}`,
      `💳 *Forma de pagamento:* ${buildBillingTypeLabel(cobranca.billing_type)}`,
      `📝 *Descrição:* ${cobranca.descricao}`,
      extrasBlock.trimEnd(),
      "",
      "Se precisar de qualquer apoio, estamos por aqui. ✅",
    ].join("\n");
  }

  if (tipo === "atraso") {
    const diasAtraso = Math.max(1, diffDays(cobranca.vencimento, todayDateOnly()));
    const encargos: string[] = [];

    if (ensureNumber(cobranca.multa_percentual) > 0) {
      encargos.push(`Multa: ${ensureMoney(cobranca.multa_percentual)}%`);
    }
    if (ensureNumber(cobranca.juros_percentual) > 0) {
      encargos.push(`Juros: ${ensureMoney(cobranca.juros_percentual)}% ao mês`);
    }

    return [
      "🔴 *Cobrança em Atraso*",
      "",
      `Olá, ${nome}! Identificamos uma cobrança em aberto:`,
      "",
      `💰 *Valor:* ${formatCurrency(cobranca.valor)}`,
      `📅 *Vencimento:* ${formatDateBr(cobranca.vencimento)} (${diasAtraso} dia(s) em atraso)`,
      `💳 *Forma de pagamento:* ${buildBillingTypeLabel(cobranca.billing_type)}`,
      `📝 *Descrição:* ${cobranca.descricao}`,
      encargos.length ? `⚠️ *Encargos:* ${encargos.join(" | ")}` : "",
      extrasBlock.trimEnd(),
      "",
      "Se já realizou o pagamento, por favor nos avise. 🙏",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (tipo === "confirmacao_pagamento") {
    return [
      "✅ *Pagamento Confirmado*",
      "",
      `Olá, ${nome}! Recebemos a confirmação do seu pagamento:`,
      "",
      `💰 *Valor pago:* ${formatCurrency(valorPago)}`,
      `📅 *Data:* ${formatTimestampBr(cobranca.pago_em)}`,
      `📝 *Descrição:* ${cobranca.descricao}`,
      "",
      "Muito obrigado! 🙏",
    ].join("\n");
  }

  return [
    "⚪ *Cobrança Cancelada*",
    "",
    `Olá, ${nome}. Esta cobrança foi cancelada:`,
    "",
    `📝 *Descrição:* ${cobranca.descricao}`,
    `📅 *Vencimento original:* ${formatDateBr(cobranca.vencimento)}`,
    "",
    "Desconsidere esta cobrança. ✅",
  ].join("\n");
}

export async function enviarNotificacaoWhatsApp(
  userId: number,
  cobranca: Cobranca,
  tipo: ChargeMessageType
): Promise<{ ok: boolean; error?: string }> {
  try {
    const charge = mapCobranca(cobranca as unknown as CobrancaRow);
    const userPreferences = await loadUserChargePreferences(userId);
    const resolved = await resolveNotificationClient(userId, charge.session_name);
    if (!resolved) {
      return { ok: false, error: "Nenhuma sessão WPP conectada" };
    }

    const phone = normalizePhone(charge.cliente_telefone);
    const chatId = `${phone}@c.us`;
    const message = buildMensagemCobranca(
      charge,
      tipo,
      userPreferences.templates
    );

    await resolved.client.sendText(chatId, message);

    const db = getDB();
    const updates: string[] = ["session_name = ?", "updated_at = ?"];
    const params: any[] = [resolved.sessionName, nowMs()];

    if (tipo === "criacao") {
      updates.push("notificado_criacao = 1");
    } else if (tipo === "lembrete_vencimento") {
      updates.push("notificado_vencimento = 1");
    } else if (tipo === "atraso") {
      updates.push("notificado_atraso = 1");
    }

    params.push(charge.id);

    await db.run(
      `
      UPDATE cobrancas
      SET ${updates.join(", ")}
      WHERE id = ?
      `,
      params
    );

    return { ok: true };
  } catch (error) {
    console.error("Erro ao enviar notificação de cobrança via WhatsApp:", error);
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Falha ao enviar mensagem via WhatsApp",
    };
  }
}
