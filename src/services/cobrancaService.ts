import { getDB, type DBClient, withDBTransaction } from "../database";
import { emitToUser } from "../lib/socketEmitter";
import { logAudit } from "../utils/audit";
import { ensureChat, getClient } from "../wppManager";
import {
  buildChargeWhatsappFailureSnapshot,
  getChargeWhatsappDeliveryStatusFromAck,
  normalizeChargeWhatsappAckValue,
  normalizeChargeWhatsappMessageId,
  parseChargeWhatsappDeliveryStatus,
  type ChargeWhatsappDeliveryStatus,
} from "./cobrancaWhatsappTracking";

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
  whatsapp_ultimo_tipo?: ChargeMessageType;
  whatsapp_ultimo_status?: ChargeWhatsappDeliveryStatus;
  whatsapp_ultimo_ack?: number;
  whatsapp_ultima_mensagem_id?: string;
  whatsapp_ultimo_erro?: string;
  whatsapp_ultimo_envio_em?: number;
  whatsapp_ultimo_entregue_em?: number;
  whatsapp_ultimo_lido_em?: number;
  whatsapp_ultimo_status_em?: number;
  mp_preference_id?: string;
  mp_payment_id?: string;
  mp_checkout_url?: string;
  mp_status?: string;
  mp_updated_at?: number;
  notificado_criacao: boolean;
  notificado_vencimento: boolean;
  notificado_atraso: boolean;
  notificado_confirmacao_pagamento: boolean;
  pago_em?: number;
  created_at: number;
  updated_at: number;
};

export type CobrancaRecebimento = {
  id: number;
  cobranca_id: number;
  user_id: number;
  valor: number;
  recebido_em: number;
  observacao?: string;
  created_at: number;
  updated_at: number;
};

export type CobrancaRecebimentoResumo = {
  total_recebido: number;
  saldo_aberto: number;
  quantidade: number;
  historico_disponivel: boolean;
};

export type CobrancaDetalhada = {
  cobranca: Cobranca;
  recebimentos: CobrancaRecebimento[];
  resumo: CobrancaRecebimentoResumo;
};

export type ClienteDashboardResumo = {
  total_cobrancas: number;
  total_recebido: number;
  total_em_aberto: number;
  total_vencido: number;
  cobrancas_abertas: number;
  recorrencias_ativas: number;
};

export type ClienteDashboard = {
  cliente: CobrancaCliente;
  resumo: ClienteDashboardResumo;
  cobrancas: Cobranca[];
  recorrencias: Recorrencia[];
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
  valor_pago_mes_anterior: number;
  variacao_recebimento_percentual: number | null;
  variacao_recebimento_valor: number;
  variacao_recebimento_direcao: "up" | "down" | "flat" | "new";
  valor_vencido: number;
  total_clientes: number;
  total_recorrencias_ativas: number;
  recebimentos_ultimos_6_meses: {
    mes: string;
    label: string;
    valor: number;
  }[];
};

export type FinancialHealthLevel = "green" | "yellow" | "red";

export type FinancialHealthAgingBucket = {
  faixa: "1-7 dias" | "8-30 dias" | "+30 dias";
  qtd: number;
  valor: number;
};

export type FinancialHealthAlert = {
  cliente_id: number;
  cliente_nome: string;
  cliente_telefone: string;
  total_vencido: number;
  vencimento_mais_antigo: string;
  dias_em_atraso: number;
  total_cobrancas: number;
};

export type FinancialHealthData = {
  mrr: number;
  recorrencias_ativas: number;
  churn: {
    total: number;
    valor: number;
    mes: string;
  };
  aging: FinancialHealthAgingBucket[];
  alertas: FinancialHealthAlert[];
  valor_vencido_total: number;
  inadimplencia_percentual: number;
  total_clientes_inadimplentes: number;
  total_cobrancas_vencidas: number;
  health_level: FinancialHealthLevel;
  health_label: string;
};

export type ChargeMessageType =
  | "criacao"
  | "lembrete_vencimento"
  | "atraso"
  | "confirmacao_pagamento"
  | "cancelamento";

export type ChargeMessageTemplates = Record<ChargeMessageType, string | null>;

export type ChargeCadenceTrigger =
  | "ANTES_VENCIMENTO"
  | "NO_VENCIMENTO"
  | "APOS_VENCIMENTO";

export type ChargeCadenceChannel = "WHATSAPP";

export type ChargeCadenceRule = {
  id: number;
  user_id: number;
  slot: number;
  nome: string;
  gatilho: ChargeCadenceTrigger;
  dias_offset: number;
  horario_envio: string;
  canal: ChargeCadenceChannel;
  ativo: boolean;
  template_customizado: string | null;
  created_at: number;
  updated_at: number;
};

export type ChargeCadenceRuleInput = {
  id?: number;
  nome?: string | null;
  gatilho: ChargeCadenceTrigger;
  dias_offset?: number;
  horario_envio?: string;
  canal?: ChargeCadenceChannel;
  ativo?: boolean;
  template_customizado?: string | null;
};

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
  whatsapp_ultimo_tipo: string | null;
  whatsapp_ultimo_status: string | null;
  whatsapp_ultimo_ack: number | null;
  whatsapp_ultima_mensagem_id: string | null;
  whatsapp_ultimo_erro: string | null;
  whatsapp_ultimo_envio_em: number | null;
  whatsapp_ultimo_entregue_em: number | null;
  whatsapp_ultimo_lido_em: number | null;
  whatsapp_ultimo_status_em: number | null;
  mp_preference_id: string | null;
  mp_payment_id: string | null;
  mp_checkout_url: string | null;
  mp_status: string | null;
  mp_updated_at: number | null;
  notificado_criacao: number | boolean;
  notificado_vencimento: number | boolean;
  notificado_atraso: number | boolean;
  notificado_confirmacao_pagamento: number | boolean;
  pago_em: number | null;
  created_at: number;
  updated_at: number;
};

type CobrancaRecebimentoRow = {
  id: number;
  cobranca_id: number;
  user_id: number;
  valor: number | string;
  recebido_em: number | string;
  observacao: string | null;
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

type ChargeCadenceRuleRow = {
  id: number;
  user_id: number;
  slot: number | string;
  nome: string;
  gatilho: ChargeCadenceTrigger;
  dias_offset: number | string;
  horario_envio: string;
  canal: ChargeCadenceChannel | string;
  ativo: number | boolean;
  template_customizado: string | null;
  created_at: number;
  updated_at: number;
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

const CHARGE_CADENCE_TRIGGERS: ChargeCadenceTrigger[] = [
  "ANTES_VENCIMENTO",
  "NO_VENCIMENTO",
  "APOS_VENCIMENTO",
];

const CHARGE_CADENCE_CHANNELS: ChargeCadenceChannel[] = ["WHATSAPP"];

const LEGACY_DEFAULT_CHARGE_CADENCE_RULES: Omit<
  ChargeCadenceRule,
  "id" | "user_id" | "slot" | "created_at" | "updated_at"
>[] = [
  {
    nome: "Aviso 3 dias antes",
    gatilho: "ANTES_VENCIMENTO",
    dias_offset: 3,
    horario_envio: "09:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
  {
    nome: "No vencimento",
    gatilho: "NO_VENCIMENTO",
    dias_offset: 0,
    horario_envio: "08:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
  {
    nome: "Atraso de 2 dias",
    gatilho: "APOS_VENCIMENTO",
    dias_offset: 2,
    horario_envio: "10:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
  {
    nome: "Atraso de 7 dias",
    gatilho: "APOS_VENCIMENTO",
    dias_offset: 7,
    horario_envio: "10:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
];

const DEFAULT_CHARGE_CADENCE_RULES: Omit<
  ChargeCadenceRule,
  "id" | "user_id" | "slot" | "created_at" | "updated_at"
>[] = [
  {
    nome: "Aviso 2 dias antes",
    gatilho: "ANTES_VENCIMENTO",
    dias_offset: 2,
    horario_envio: "09:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
  {
    nome: "No vencimento",
    gatilho: "NO_VENCIMENTO",
    dias_offset: 0,
    horario_envio: "08:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
  {
    nome: "Atraso de 3 dias",
    gatilho: "APOS_VENCIMENTO",
    dias_offset: 3,
    horario_envio: "10:00",
    canal: "WHATSAPP",
    ativo: true,
    template_customizado: null,
  },
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

function normalizeBoundedNullableText(value: unknown, maxLength = 0) {
  const text = nullableString(value);
  if (!text) return null;
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function normalizeBoundedRequiredText(
  value: unknown,
  fallback: string,
  maxLength = 0
) {
  const text = cleanString(value) || fallback;
  return maxLength > 0 ? text.slice(0, maxLength) : text;
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

function getShiftedDateByOffset(offsetMinutes?: number | null, baseDate = new Date()) {
  return new Date(baseDate.getTime() + ensureNumber(offsetMinutes) * 60 * 1000);
}

function formatShiftedDateOnly(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShiftedYearMonth(date: Date) {
  return formatShiftedDateOnly(date).slice(0, 7);
}

function isUserLocalMonday(offsetMinutes?: number | null, baseDate = new Date()) {
  return getShiftedDateByOffset(offsetMinutes, baseDate).getUTCDay() === 1;
}

function getUserLocalToday(offsetMinutes?: number | null, baseDate = new Date()) {
  return formatShiftedDateOnly(getShiftedDateByOffset(offsetMinutes, baseDate));
}

function getUserLocalMonthKey(offsetMinutes?: number | null, baseDate = new Date()) {
  return formatShiftedYearMonth(getShiftedDateByOffset(offsetMinutes, baseDate));
}

function getUserLocalWeekKey(offsetMinutes?: number | null, baseDate = new Date()) {
  const shifted = getShiftedDateByOffset(offsetMinutes, baseDate);
  const weekday = shifted.getUTCDay();
  const mondayDelta = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(shifted.getTime() + mondayDelta * 24 * 60 * 60 * 1000);
  return formatShiftedDateOnly(monday);
}

function getUserLocalMonthRange(
  offsetMinutes?: number | null,
  monthShift = 0,
  baseDate = new Date()
) {
  const offsetMs = ensureNumber(offsetMinutes) * 60 * 1000;
  const shiftedBase = getShiftedDateByOffset(offsetMinutes, baseDate);
  const startMs =
    Date.UTC(
      shiftedBase.getUTCFullYear(),
      shiftedBase.getUTCMonth() + monthShift,
      1,
      0,
      0,
      0,
      0
    ) - offsetMs;
  const endMs =
    Date.UTC(
      shiftedBase.getUTCFullYear(),
      shiftedBase.getUTCMonth() + monthShift + 1,
      1,
      0,
      0,
      0,
      0
    ) - offsetMs;
  const shiftedStart = new Date(startMs + offsetMs);
  const label = new Intl.DateTimeFormat("pt-BR", {
    month: "short",
    timeZone: "UTC",
  })
    .format(shiftedStart)
    .replace(/\./g, "");

  return {
    key: formatShiftedYearMonth(shiftedStart),
    label: label.charAt(0).toUpperCase() + label.slice(1),
    startMs,
    endMs,
  };
}

export function getUserLocalTimeSnapshot(
  offsetMinutes?: number | null,
  baseDate = new Date()
) {
  const shifted = getShiftedDateByOffset(offsetMinutes, baseDate);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");

  return {
    date: formatShiftedDateOnly(shifted),
    time: `${hours}:${minutes}`,
  };
}

function getFinancialHealthLevel(inadimplenciaPercentual: number): FinancialHealthLevel {
  if (inadimplenciaPercentual > 15) return "red";
  if (inadimplenciaPercentual >= 5) return "yellow";
  return "green";
}

function getFinancialHealthLabel(level: FinancialHealthLevel) {
  switch (level) {
    case "red":
      return "Crítico";
    case "yellow":
      return "Atenção";
    default:
      return "Saudável";
  }
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

async function listUserChargeCadenceRulesFromDB(
  db: DBClient,
  userId: number
): Promise<ChargeCadenceRule[]> {
  const rows = await db.all<ChargeCadenceRuleRow>(
    `
    SELECT
      id,
      user_id,
      slot,
      nome,
      gatilho,
      dias_offset,
      horario_envio,
      canal,
      ativo,
      template_customizado,
      created_at,
      updated_at
    FROM cobranca_regua_rules
    WHERE user_id = ?
    ORDER BY slot ASC, id ASC
    `,
    [userId]
  );

  return rows.map(mapChargeCadenceRule);
}

function matchesChargeCadencePreset(
  rules: ChargeCadenceRule[],
  preset: typeof DEFAULT_CHARGE_CADENCE_RULES
) {
  if (rules.length !== preset.length) {
    return false;
  }

  return rules.every((rule, index) => {
    const expected = preset[index];
    return (
      rule.slot === index + 1 &&
      rule.nome === expected.nome &&
      rule.gatilho === expected.gatilho &&
      rule.dias_offset === expected.dias_offset &&
      rule.horario_envio === expected.horario_envio &&
      rule.canal === expected.canal &&
      rule.ativo === expected.ativo &&
      (rule.template_customizado || null) === expected.template_customizado
    );
  });
}

async function migrateLegacyChargeCadencePresetIfNeeded(
  db: DBClient,
  userId: number,
  existing: ChargeCadenceRule[]
) {
  if (!matchesChargeCadencePreset(existing, LEGACY_DEFAULT_CHARGE_CADENCE_RULES)) {
    return existing;
  }

  const now = nowMs();
  for (const [index, rule] of DEFAULT_CHARGE_CADENCE_RULES.entries()) {
    const current = existing[index];
    if (!current) continue;

    await db.run(
      `
      UPDATE cobranca_regua_rules
      SET
        slot = ?,
        nome = ?,
        gatilho = ?,
        dias_offset = ?,
        horario_envio = ?,
        canal = ?,
        ativo = ?,
        template_customizado = ?,
        updated_at = ?
      WHERE user_id = ? AND id = ?
      `,
      [
        index + 1,
        rule.nome,
        rule.gatilho,
        rule.dias_offset,
        rule.horario_envio,
        rule.canal,
        rule.ativo ? 1 : 0,
        rule.template_customizado,
        now,
        userId,
        current.id,
      ]
    );
  }

  if (existing.length > DEFAULT_CHARGE_CADENCE_RULES.length) {
    const idsToDelete = existing
      .slice(DEFAULT_CHARGE_CADENCE_RULES.length)
      .map((rule) => rule.id);
    const placeholders = idsToDelete.map(() => "?").join(", ");

    await db.run(
      `
      DELETE FROM cobranca_regua_rules
      WHERE user_id = ?
        AND id IN (${placeholders})
      `,
      [userId, ...idsToDelete]
    );
  }

  await db.run(
    `
    DELETE FROM cobranca_notifications_queue
    WHERE user_id = ?
      AND regua_rule_id > 0
      AND status = 'pending'
    `,
    [userId]
  );

  return listUserChargeCadenceRulesFromDB(db, userId);
}

export async function ensureUserChargeCadenceRules(
  userId: number
): Promise<ChargeCadenceRule[]> {
  const db = getDB();
  const existing = await listUserChargeCadenceRulesFromDB(db, userId);
  if (existing.length) {
    return migrateLegacyChargeCadencePresetIfNeeded(db, userId, existing);
  }

  const now = nowMs();
  for (const [index, rule] of DEFAULT_CHARGE_CADENCE_RULES.entries()) {
    await db.run(
      `
      INSERT INTO cobranca_regua_rules (
        user_id,
        slot,
        nome,
        gatilho,
        dias_offset,
        horario_envio,
        canal,
        ativo,
        template_customizado,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE updated_at = updated_at
      `,
      [
        userId,
        index + 1,
        rule.nome,
        rule.gatilho,
        rule.dias_offset,
        rule.horario_envio,
        rule.canal,
        rule.ativo ? 1 : 0,
        rule.template_customizado,
        now,
        now,
      ]
    );
  }

  return listUserChargeCadenceRulesFromDB(db, userId);
}

export async function listUserChargeCadenceRules(
  userId: number
): Promise<ChargeCadenceRule[]> {
  return ensureUserChargeCadenceRules(userId);
}

export async function buscarChargeCadenceRule(
  userId: number,
  ruleId: number
): Promise<ChargeCadenceRule | null> {
  if (!Number.isFinite(Number(ruleId)) || Number(ruleId) <= 0) {
    return null;
  }

  const db = getDB();
  const row = await db.get<ChargeCadenceRuleRow>(
    `
    SELECT
      id,
      user_id,
      slot,
      nome,
      gatilho,
      dias_offset,
      horario_envio,
      canal,
      ativo,
      template_customizado,
      created_at,
      updated_at
    FROM cobranca_regua_rules
    WHERE user_id = ? AND id = ?
    LIMIT 1
    `,
    [userId, ruleId]
  );

  return row ? mapChargeCadenceRule(row) : null;
}

export async function saveUserChargeCadenceRules(
  userId: number,
  inputRules: ChargeCadenceRuleInput[]
): Promise<ChargeCadenceRule[]> {
  if (!Array.isArray(inputRules) || !inputRules.length) {
    throw new Error("Informe ao menos uma etapa da régua.");
  }

  if (inputRules.length > 12) {
    throw new Error("A régua suporta no máximo 12 etapas.");
  }

  const existing = await ensureUserChargeCadenceRules(userId);
  const existingIds = new Set(existing.map((rule) => rule.id));

  const normalizedRules = inputRules.map((rule, index) => {
    const gatilho = assertChargeCadenceTrigger(rule?.gatilho);
    const diasOffset = normalizeChargeCadenceDays(gatilho, rule?.dias_offset);
    const fallbackName =
      existing[index]?.nome || buildDefaultChargeCadenceName(gatilho, diasOffset);
    const id = Number(rule?.id || 0);

    if (id > 0 && !existingIds.has(id)) {
      throw new Error("Etapa da régua inválida.");
    }

    return {
      id: id > 0 ? id : null,
      slot: index + 1,
      nome: normalizeBoundedRequiredText(rule?.nome, fallbackName, 80),
      gatilho,
      dias_offset: diasOffset,
      horario_envio: normalizeChargeCadenceTime(rule?.horario_envio || "09:00"),
      canal: assertChargeCadenceChannel(rule?.canal || "WHATSAPP"),
      ativo: Boolean(rule?.ativo),
      template_customizado: normalizeBoundedNullableText(
        rule?.template_customizado,
        6000
      ),
    };
  });

  const savedIds = await withDBTransaction(async (db) => {
    const persistedIds: number[] = [];

    for (const rule of normalizedRules) {
      if (rule.id) {
        await db.run(
          `
          UPDATE cobranca_regua_rules
          SET
            nome = ?,
            slot = ?,
            gatilho = ?,
            dias_offset = ?,
            horario_envio = ?,
            canal = ?,
            ativo = ?,
            template_customizado = ?,
            updated_at = ?
          WHERE user_id = ? AND id = ?
          `,
          [
            rule.nome,
            rule.slot,
            rule.gatilho,
            rule.dias_offset,
            rule.horario_envio,
            rule.canal,
            rule.ativo ? 1 : 0,
            rule.template_customizado,
            nowMs(),
            userId,
            rule.id,
          ]
        );
        persistedIds.push(rule.id);
        continue;
      }

      const inserted = await db.run(
        `
        INSERT INTO cobranca_regua_rules (
          user_id,
          slot,
          nome,
          gatilho,
          dias_offset,
          horario_envio,
          canal,
          ativo,
          template_customizado,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          userId,
          rule.slot,
          rule.nome,
          rule.gatilho,
          rule.dias_offset,
          rule.horario_envio,
          rule.canal,
          rule.ativo ? 1 : 0,
          rule.template_customizado,
          nowMs(),
          nowMs(),
        ]
      );
      persistedIds.push(ensureNumber(inserted.insertId));
    }

    if (persistedIds.length) {
      const placeholders = persistedIds.map(() => "?").join(", ");
      await db.run(
        `
        DELETE FROM cobranca_regua_rules
        WHERE user_id = ?
          AND id NOT IN (${placeholders})
        `,
        [userId, ...persistedIds]
      );
    } else {
      await db.run(`DELETE FROM cobranca_regua_rules WHERE user_id = ?`, [userId]);
    }

    await db.run(
      `
      DELETE FROM cobranca_notifications_queue
      WHERE user_id = ?
        AND regua_rule_id > 0
        AND status = 'pending'
      `,
      [userId]
    );

    return persistedIds;
  });

  const savedRules = await listUserChargeCadenceRulesFromDB(getDB(), userId);
  const savedById = new Map(savedRules.map((rule) => [rule.id, rule]));

  return savedIds
    .map((id) => savedById.get(id))
    .filter((rule): rule is ChargeCadenceRule => Boolean(rule));
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

function assertChargeCadenceTrigger(value: unknown): ChargeCadenceTrigger {
  if (!CHARGE_CADENCE_TRIGGERS.includes(value as ChargeCadenceTrigger)) {
    throw new Error("Gatilho da régua inválido.");
  }
  return value as ChargeCadenceTrigger;
}

function assertChargeCadenceChannel(value: unknown): ChargeCadenceChannel {
  if (!CHARGE_CADENCE_CHANNELS.includes(value as ChargeCadenceChannel)) {
    throw new Error("Canal da régua inválido.");
  }
  return value as ChargeCadenceChannel;
}

function normalizeChargeCadenceTime(value: unknown) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error("Horário da régua inválido.");
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw new Error("Horário da régua inválido.");
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizeChargeCadenceDays(
  gatilho: ChargeCadenceTrigger,
  value: unknown
) {
  const numeric = Math.floor(ensureNumber(value, 0));
  if (gatilho === "NO_VENCIMENTO") {
    return 0;
  }

  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 3650) {
    throw new Error("Dias da régua inválidos.");
  }

  return numeric;
}

function buildDefaultChargeCadenceName(
  gatilho: ChargeCadenceTrigger,
  diasOffset: number
) {
  if (gatilho === "ANTES_VENCIMENTO") {
    return `Aviso ${diasOffset} dia(s) antes`;
  }
  if (gatilho === "NO_VENCIMENTO") {
    return "No vencimento";
  }
  return `Atraso de ${diasOffset} dia(s)`;
}

function mapChargeCadenceRule(row: ChargeCadenceRuleRow): ChargeCadenceRule {
  return {
    id: ensureNumber(row.id),
    user_id: ensureNumber(row.user_id),
    slot: ensureNumber(row.slot),
    nome: row.nome,
    gatilho: assertChargeCadenceTrigger(row.gatilho),
    dias_offset: ensureNumber(row.dias_offset),
    horario_envio: normalizeChargeCadenceTime(row.horario_envio),
    canal: assertChargeCadenceChannel(row.canal),
    ativo: ensureBoolean(row.ativo),
    template_customizado: normalizeBoundedNullableText(
      row.template_customizado,
      6000
    ),
    created_at: ensureNumber(row.created_at),
    updated_at: ensureNumber(row.updated_at),
  };
}

export function getChargeCadenceMessageType(
  gatilho: ChargeCadenceTrigger
): "lembrete_vencimento" | "atraso" {
  return gatilho === "APOS_VENCIMENTO" ? "atraso" : "lembrete_vencimento";
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
    whatsapp_ultimo_tipo: (row.whatsapp_ultimo_tipo || undefined) as
      | ChargeMessageType
      | undefined,
    whatsapp_ultimo_status:
      parseChargeWhatsappDeliveryStatus(row.whatsapp_ultimo_status) || undefined,
    whatsapp_ultimo_ack:
      row.whatsapp_ultimo_ack == null
        ? undefined
        : ensureNumber(row.whatsapp_ultimo_ack),
    whatsapp_ultima_mensagem_id: row.whatsapp_ultima_mensagem_id || undefined,
    whatsapp_ultimo_erro: row.whatsapp_ultimo_erro || undefined,
    whatsapp_ultimo_envio_em:
      row.whatsapp_ultimo_envio_em == null
        ? undefined
        : ensureNumber(row.whatsapp_ultimo_envio_em),
    whatsapp_ultimo_entregue_em:
      row.whatsapp_ultimo_entregue_em == null
        ? undefined
        : ensureNumber(row.whatsapp_ultimo_entregue_em),
    whatsapp_ultimo_lido_em:
      row.whatsapp_ultimo_lido_em == null
        ? undefined
        : ensureNumber(row.whatsapp_ultimo_lido_em),
    whatsapp_ultimo_status_em:
      row.whatsapp_ultimo_status_em == null
        ? undefined
        : ensureNumber(row.whatsapp_ultimo_status_em),
    mp_preference_id: row.mp_preference_id || undefined,
    mp_payment_id: row.mp_payment_id || undefined,
    mp_checkout_url: row.mp_checkout_url || undefined,
    mp_status: row.mp_status || undefined,
    mp_updated_at:
      row.mp_updated_at == null ? undefined : ensureNumber(row.mp_updated_at),
    notificado_criacao: ensureBoolean(row.notificado_criacao),
    notificado_vencimento: ensureBoolean(row.notificado_vencimento),
    notificado_atraso: ensureBoolean(row.notificado_atraso),
    notificado_confirmacao_pagamento: ensureBoolean(
      row.notificado_confirmacao_pagamento
    ),
    pago_em: row.pago_em == null ? undefined : ensureNumber(row.pago_em),
    created_at: ensureNumber(row.created_at),
    updated_at: ensureNumber(row.updated_at),
  };
}

function mapCobrancaRecebimento(
  row: CobrancaRecebimentoRow
): CobrancaRecebimento {
  return {
    id: ensureNumber(row.id),
    cobranca_id: ensureNumber(row.cobranca_id),
    user_id: ensureNumber(row.user_id),
    valor: ensureMoney(row.valor),
    recebido_em: ensureNumber(row.recebido_em),
    observacao: row.observacao || undefined,
    created_at: ensureNumber(row.created_at),
    updated_at: ensureNumber(row.updated_at),
  };
}

function isParentInstallmentCharge(
  charge:
    | Pick<Cobranca, "cobranca_pai_id" | "parcelas" | "parcela_atual">
    | Pick<CobrancaRow, "cobranca_pai_id" | "parcelas" | "parcela_atual">
) {
  return (
    charge.cobranca_pai_id == null &&
    ensureNumber(charge.parcelas, 1) > 1 &&
    ensureNumber(charge.parcela_atual, 0) <= 0
  );
}

function resolveOpenChargeStatus(vencimento: string): ChargeStatus {
  return vencimento < todayDateOnly() ? "VENCIDO" : "PENDENTE";
}

function buildChargeReceiptSummary(
  charge: Cobranca,
  receipts: CobrancaRecebimento[]
): CobrancaRecebimentoResumo {
  const hasReceipts = receipts.length > 0;
  const totalRecebido = hasReceipts
    ? ensureMoney(receipts.reduce((sum, item) => sum + ensureMoney(item.valor), 0))
    : ensureMoney(charge.valor_pago);

  return {
    total_recebido: totalRecebido,
    saldo_aberto: Math.max(0, ensureMoney(charge.valor - totalRecebido)),
    quantidade: receipts.length,
    historico_disponivel: hasReceipts || totalRecebido <= 0,
  };
}

function getChargePaidAmount(
  charge: Pick<Cobranca, "valor" | "valor_pago">
) {
  return Math.max(
    0,
    Math.min(ensureMoney(charge.valor_pago), ensureMoney(charge.valor))
  );
}

function getChargeOpenAmount(
  charge: Pick<Cobranca, "valor" | "valor_pago" | "status">
) {
  if (charge.status === "PAGO" || charge.status === "CANCELADO") {
    return 0;
  }

  return Math.max(
    0,
    ensureMoney(ensureMoney(charge.valor) - getChargePaidAmount(charge))
  );
}

function isChargeOverdue(
  charge: Pick<Cobranca, "valor" | "valor_pago" | "status" | "vencimento">
) {
  return (
    getChargeOpenAmount(charge) > 0 &&
    charge.status !== "CANCELADO" &&
    charge.vencimento < todayDateOnly()
  );
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

async function listChargeReceipts(
  db: DBClient,
  userId: number,
  cobrancaId: number
) {
  const rows = await db.all<CobrancaRecebimentoRow>(
    `
    SELECT *
    FROM cobranca_recebimentos
    WHERE user_id = ? AND cobranca_id = ?
    ORDER BY recebido_em DESC, id DESC
    `,
    [userId, cobrancaId]
  );

  return rows.map(mapCobrancaRecebimento);
}

async function getChargeReceiptsSummary(
  db: DBClient,
  cobrancaId: number
) {
  return db.get<{
    total_recebido: number | string | null;
    quantidade: number | null;
    ultimo_recebimento: number | string | null;
  }>(
    `
    SELECT
      COALESCE(SUM(valor), 0) AS total_recebido,
      COUNT(*) AS quantidade,
      MAX(recebido_em) AS ultimo_recebimento
    FROM cobranca_recebimentos
    WHERE cobranca_id = ?
    `,
    [cobrancaId]
  );
}

async function recalculateChargePaymentState(
  db: DBClient,
  currentRow: CobrancaRow
) {
  const current = mapCobranca(currentRow);
  const totals = await getChargeReceiptsSummary(db, current.id);
  const totalRecebido = ensureMoney(totals?.total_recebido);
  const wasFullyPaid = current.status === "PAGO";

  let nextStatus: ChargeStatus;
  let pagoEm: number | null = null;

  if (totalRecebido <= 0) {
    nextStatus = resolveOpenChargeStatus(current.vencimento);
  } else if (totalRecebido >= current.valor) {
    nextStatus = "PAGO";
    pagoEm = ensureNumber(totals?.ultimo_recebimento) || nowMs();
  } else {
    nextStatus = "PARCIAL";
  }

  await db.run(
    `
    UPDATE cobrancas
    SET status = ?, valor_pago = ?, pago_em = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
    `,
    [
      nextStatus,
      totalRecebido > 0 ? totalRecebido : null,
      pagoEm,
      nowMs(),
      current.user_id,
      current.id,
    ]
  );

  const updatedRow = await getCobrancaById(db, current.user_id, current.id);
  if (!updatedRow) {
    throw new Error("Não foi possível recarregar a cobrança após atualizar o recebimento.");
  }

  return {
    cobranca: mapCobranca(updatedRow),
    completedNow: !wasFullyPaid && nextStatus === "PAGO",
  };
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
    ultimo_pago_em: number | string | null;
  }>(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'PAGO' THEN 1 ELSE 0 END) AS pagos,
      SUM(CASE WHEN status = 'CANCELADO' THEN 1 ELSE 0 END) AS cancelados,
      SUM(
        CASE
          WHEN status = 'PAGO' THEN COALESCE(valor_pago, valor)
          WHEN status = 'PARCIAL' THEN COALESCE(valor_pago, 0)
          ELSE 0
        END
      ) AS valor_pago,
      MAX(CASE WHEN status = 'PAGO' THEN pago_em ELSE NULL END) AS ultimo_pago_em
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
    pagoEm = ensureNumber(summary.ultimo_pago_em) || nowMs();
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

function getFriendlyChargeWhatsappError(error: unknown) {
  const rawMessage =
    error instanceof Error ? error.message : String(error || "");
  const message = rawMessage.toLowerCase();

  if (
    message.includes("no lid for user") ||
    message.includes("número inválido ou não registrado no whatsapp") ||
    message.includes("numero inválido ou não registrado no whatsapp") ||
    message.includes("not registered")
  ) {
    return "Número não encontrado no WhatsApp. Confira se ele está correto, com DDI e DDD, e se esse contato possui WhatsApp.";
  }

  return rawMessage || "Falha ao enviar mensagem via WhatsApp";
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

export async function buscarDashboardCliente(
  userId: number,
  clienteId: number
): Promise<ClienteDashboard | null> {
  const db = getDB();
  const clienteRow = await getClienteById(db, userId, clienteId);
  if (!clienteRow) return null;

  const [chargeRows, recurrenceRows] = await Promise.all([
    db.all<CobrancaRow>(
      `
      SELECT *
      FROM cobrancas
      WHERE user_id = ?
        AND cliente_id = ?
        AND NOT (
          status = 'PARCIAL'
          AND cobranca_pai_id IS NULL
          AND COALESCE(parcela_atual, 0) = 0
          AND COALESCE(parcelas, 1) > 1
        )
      ORDER BY vencimento DESC, id DESC
      `,
      [userId, clienteId]
    ),
    db.all<RecorrenciaRow>(
      `
      SELECT *
      FROM cobrancas_recorrencias
      WHERE user_id = ? AND cliente_id = ? AND ativa = 1
      ORDER BY proxima_cobranca ASC, id DESC
      `,
      [userId, clienteId]
    ),
  ]);

  const cobrancas = chargeRows.map(mapCobranca);
  const recorrencias = recurrenceRows.map(mapRecorrencia);
  const resumoBase: ClienteDashboardResumo = {
    total_cobrancas: cobrancas.length,
    total_recebido: 0,
    total_em_aberto: 0,
    total_vencido: 0,
    cobrancas_abertas: 0,
    recorrencias_ativas: recorrencias.length,
  };

  const resumo = cobrancas.reduce((acc, charge) => {
    const paidAmount = getChargePaidAmount(charge);
    const openAmount = getChargeOpenAmount(charge);

    acc.total_recebido = ensureMoney(acc.total_recebido + paidAmount);
    acc.total_em_aberto = ensureMoney(acc.total_em_aberto + openAmount);

    if (openAmount > 0) {
      acc.cobrancas_abertas += 1;
    }

    if (isChargeOverdue(charge)) {
      acc.total_vencido = ensureMoney(acc.total_vencido + openAmount);
    }

    return acc;
  }, resumoBase);

  return {
    cliente: mapCliente(clienteRow),
    resumo,
    cobrancas,
    recorrencias,
  };
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

type ChargeListFilters = {
  status?: ChargeStatus | "all";
  search?: string;
  from?: string;
  to?: string;
  cliente_id?: number;
  recorrencia_id?: number;
  page?: number;
  pageSize?: number;
};

const CHARGE_LIST_ORDER_BY_SQL = `
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
`;

function buildChargeListQuery(userId: number, filters: ChargeListFilters) {
  const params: any[] = [userId];
  const whereParts = [`c.user_id = ?`];

  const status = cleanString(filters.status);
  if (status && status !== "all") {
    whereParts.push(`c.status = ?`);
    params.push(status);
  } else {
    whereParts.push(
      `NOT (
        c.status = 'PARCIAL'
        AND c.cobranca_pai_id IS NULL
        AND COALESCE(c.parcela_atual, 0) = 0
        AND COALESCE(c.parcelas, 1) > 1
      )`
    );
  }

  const search = cleanString(filters.search);
  if (search) {
    const like = `%${search}%`;
    whereParts.push(
      `(c.cliente_nome LIKE ? OR c.cliente_telefone LIKE ? OR c.descricao LIKE ? OR cc.cpf_cnpj LIKE ?)`
    );
    params.push(like, like, like, like);
  }

  const from = cleanString(filters.from);
  if (from) {
    parseDateOnly(from);
    whereParts.push(`c.vencimento >= ?`);
    params.push(from);
  }

  const to = cleanString(filters.to);
  if (to) {
    parseDateOnly(to);
    whereParts.push(`c.vencimento <= ?`);
    params.push(to);
  }

  if (filters.cliente_id) {
    whereParts.push(`c.cliente_id = ?`);
    params.push(filters.cliente_id);
  }

  if (filters.recorrencia_id) {
    whereParts.push(`c.recorrencia_id = ?`);
    params.push(filters.recorrencia_id);
  }

  return {
    whereSql: whereParts.join(" AND "),
    params,
  };
}

async function queryChargeListRows(
  userId: number,
  filters: ChargeListFilters,
  pagination?: { page: number; pageSize: number }
): Promise<{ rows: CobrancaRow[]; total: number }> {
  const db = getDB();
  const { whereSql, params } = buildChargeListQuery(userId, filters);

  const totalRow = await db.get<{ total: number }>(
    `
    SELECT COUNT(*) AS total
    FROM cobrancas c
    LEFT JOIN cobranca_clientes cc ON cc.id = c.cliente_id
    WHERE ${whereSql}
    `,
    params
  );

  const rowParams = [...params];
  let listSql = `
    SELECT c.*
    FROM cobrancas c
    LEFT JOIN cobranca_clientes cc ON cc.id = c.cliente_id
    WHERE ${whereSql}
    ORDER BY ${CHARGE_LIST_ORDER_BY_SQL}
  `;

  if (pagination) {
    const offset = (pagination.page - 1) * pagination.pageSize;
    listSql += `
      LIMIT ? OFFSET ?
    `;
    rowParams.push(pagination.pageSize, offset);
  }

  const rows = await db.all<CobrancaRow>(listSql, rowParams);

  return {
    rows,
    total: ensureNumber(totalRow?.total),
  };
}

export async function listarCobrancas(
  userId: number,
  filters: ChargeListFilters
): Promise<{ charges: Cobranca[]; total: number; pages: number }> {
  const page = Math.max(1, Math.floor(ensureNumber(filters.page || 1, 1)));
  const pageSize = Math.max(
    1,
    Math.min(100, Math.floor(ensureNumber(filters.pageSize || 20, 20)))
  );
  const { rows, total } = await queryChargeListRows(userId, filters, {
    page,
    pageSize,
  });
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return {
    charges: rows.map(mapCobranca),
    total,
    pages,
  };
}

export async function listarCobrancasParaExportacao(
  userId: number,
  filters: Omit<ChargeListFilters, "page" | "pageSize">
): Promise<Cobranca[]> {
  const { rows } = await queryChargeListRows(userId, filters);
  return rows.map(mapCobranca);
}

export async function buscarCobranca(
  userId: number,
  cobrancaId: number
): Promise<Cobranca | null> {
  const db = getDB();
  const row = await getCobrancaById(db, userId, cobrancaId);
  return row ? mapCobranca(row) : null;
}

export async function buscarCobrancaDetalhada(
  userId: number,
  cobrancaId: number
): Promise<CobrancaDetalhada | null> {
  const db = getDB();
  const row = await getCobrancaById(db, userId, cobrancaId);
  if (!row) return null;

  const cobranca = mapCobranca(row);
  const recebimentos = await listChargeReceipts(db, userId, cobrancaId);

  return {
    cobranca,
    recebimentos,
    resumo: buildChargeReceiptSummary(cobranca, recebimentos),
  };
}

export async function marcarComoPago(
  userId: number,
  cobrancaId: number,
  valorPago?: number,
  pagoEm?: string,
  observacao?: string
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

    if (isParentInstallmentCharge(current)) {
      throw new Error("Marque as parcelas individualmente como pagas.");
    }

    const paidValue =
      valorPago != null && Number.isFinite(Number(valorPago))
        ? ensureMoney(valorPago)
        : ensureMoney(current.valor - ensureMoney(current.valor_pago));

    if (paidValue <= 0) {
      throw new Error("Valor pago inválido.");
    }

    const paidAt = pagoEm ? parseDateOnly(pagoEm).getTime() : nowMs();
    const note = normalizeBoundedNullableText(observacao, 1000);
    const timestamp = nowMs();

    await db.run(
      `
      INSERT INTO cobranca_recebimentos (
        cobranca_id,
        user_id,
        valor,
        recebido_em,
        observacao,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [cobrancaId, userId, paidValue, paidAt, note, timestamp, timestamp]
    );

    const recalculated = await recalculateChargePaymentState(db, currentRow);

    if (current.cobranca_pai_id) {
      await syncParentCharge(db, current.cobranca_pai_id);
    }

    if (recalculated.completedNow) {
      await createNextRecurringChargeIfNeeded(db, recalculated.cobranca);
    }

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

    if (isParentInstallmentCharge(current)) {
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
  const shouldResetMercadoPagoCheckout =
    billingType !== charge.billing_type ||
    valor !== ensureMoney(charge.valor) ||
    descricao !== charge.descricao ||
    vencimento !== charge.vencimento;

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
      mp_preference_id = ?,
      mp_payment_id = ?,
      mp_checkout_url = ?,
      mp_status = ?,
      mp_updated_at = ?,
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
      shouldResetMercadoPagoCheckout ? null : existing.mp_preference_id,
      shouldResetMercadoPagoCheckout ? null : existing.mp_payment_id,
      shouldResetMercadoPagoCheckout ? null : existing.mp_checkout_url,
      shouldResetMercadoPagoCheckout ? null : existing.mp_status,
      shouldResetMercadoPagoCheckout ? null : existing.mp_updated_at,
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

async function getReceivedRevenueTrend(
  db: DBClient,
  userId: number,
  offsetMinutes?: number | null,
  months = 6
) {
  const safeMonths = Math.max(2, Math.min(12, Math.floor(ensureNumber(months, 6))));
  const ranges = Array.from({ length: safeMonths }, (_, index) =>
    getUserLocalMonthRange(offsetMinutes, index - (safeMonths - 1))
  );
  const rangeStart = ranges[0]?.startMs ?? nowMs();
  const rangeEnd = ranges[ranges.length - 1]?.endMs ?? nowMs();
  const offsetMs = ensureNumber(offsetMinutes) * 60 * 1000;

  const rows = await db.all<{
    mes: string;
    valor: number | string | null;
  }>(
    `
    SELECT
      DATE_FORMAT(FROM_UNIXTIME((base_receipts.paid_at + ?) / 1000), '%Y-%m') AS mes,
      COALESCE(SUM(base_receipts.valor), 0) AS valor
    FROM (
      SELECT
        cr.recebido_em AS paid_at,
        cr.valor AS valor
      FROM cobranca_recebimentos cr
      WHERE cr.user_id = ?
        AND cr.recebido_em >= ?
        AND cr.recebido_em < ?

      UNION ALL

      SELECT
        c.pago_em AS paid_at,
        COALESCE(c.valor_pago, c.valor) AS valor
      FROM cobrancas c
      WHERE c.user_id = ?
        AND c.status = 'PAGO'
        AND c.pago_em IS NOT NULL
        AND c.pago_em >= ?
        AND c.pago_em < ?
        AND NOT EXISTS (
          SELECT 1
          FROM cobranca_recebimentos cr2
          WHERE cr2.cobranca_id = c.id
        )
    ) AS base_receipts
    GROUP BY mes
    ORDER BY mes ASC
    `,
    [offsetMs, userId, rangeStart, rangeEnd, userId, rangeStart, rangeEnd]
  );

  const valueByMonth = new Map(
    (rows || []).map((row) => [String(row.mes || ""), ensureMoney(row.valor)])
  );
  const points = ranges.map((range) => ({
    mes: range.key,
    label: range.label,
    valor: ensureMoney(valueByMonth.get(range.key)),
  }));

  const currentValue = ensureMoney(points[points.length - 1]?.valor);
  const previousValue = ensureMoney(points[points.length - 2]?.valor);
  const deltaValue = ensureMoney(currentValue - previousValue);

  if (previousValue > 0) {
    const deltaPercent = Math.round((deltaValue / previousValue) * 1000) / 10;
    return {
      currentValue,
      previousValue,
      deltaValue,
      deltaPercent,
      direction:
        Math.abs(deltaValue) < 0.005
          ? ("flat" as const)
          : deltaValue > 0
            ? ("up" as const)
            : ("down" as const),
      points,
    };
  }

  return {
    currentValue,
    previousValue,
    deltaValue,
    deltaPercent: currentValue > 0 ? null : 0,
    direction:
      currentValue > 0
        ? ("new" as const)
        : ("flat" as const),
    points,
  };
}

export async function getSummary(userId: number): Promise<CobrancaSummary> {
  const db = getDB();
  const userRow = await db.get<{ timezone_offset: number | null }>(
    `
    SELECT timezone_offset
    FROM users
    WHERE id = ?
    LIMIT 1
    `,
    [userId]
  );
  const revenueTrend = await getReceivedRevenueTrend(
    db,
    userId,
    userRow?.timezone_offset,
    6
  );

  const row = await db.get<{
    total_pendente: number;
    total_pago: number;
    total_vencido: number;
    total_cancelado: number;
    valor_pendente: number | string | null;
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
     AND NOT (
       c.status = 'PARCIAL'
       AND c.cobranca_pai_id IS NULL
       AND COALESCE(c.parcela_atual, 0) = 0
       AND COALESCE(c.parcelas, 1) > 1
     )
    `,
    [
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
    valor_pago_mes: revenueTrend.currentValue,
    valor_pago_mes_anterior: revenueTrend.previousValue,
    variacao_recebimento_percentual: revenueTrend.deltaPercent,
    variacao_recebimento_valor: revenueTrend.deltaValue,
    variacao_recebimento_direcao: revenueTrend.direction,
    valor_vencido: ensureMoney(row?.valor_vencido),
    total_clientes: ensureNumber(row?.total_clientes),
    total_recorrencias_ativas: ensureNumber(row?.total_recorrencias_ativas),
    recebimentos_ultimos_6_meses: revenueTrend.points,
  };
}

export async function getFinancialHealth(
  userId: number
): Promise<FinancialHealthData> {
  const db = getDB();
  const userRow = await db.get<{ timezone_offset: number | null }>(
    `
    SELECT timezone_offset
    FROM users
    WHERE id = ?
    LIMIT 1
    `,
    [userId]
  );
  const mesAtual = getUserLocalMonthKey(userRow?.timezone_offset);
  const todayLocal = getUserLocalToday(userRow?.timezone_offset);

  const [mrrRow, churnRow, agingRows, alertRows, overdueRow] = await Promise.all([
    db.get<{
      recorrencias_ativas: number;
      mrr: number | string | null;
    }>(
      `
      SELECT
        COUNT(*) AS recorrencias_ativas,
        COALESCE(SUM(valor), 0) AS mrr
      FROM cobrancas_recorrencias
      WHERE user_id = ? AND ativa = 1
      `,
      [userId]
    ),
    db.get<{
      total: number;
      valor: number | string | null;
    }>(
      `
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(valor), 0) AS valor
      FROM cobrancas
      WHERE user_id = ?
        AND status = 'CANCELADO'
        AND DATE_FORMAT(FROM_UNIXTIME(updated_at / 1000), '%Y-%m') = ?
      `,
      [userId, mesAtual]
    ),
    db.all<{
      faixa: "1-7 dias" | "8-30 dias" | "+30 dias" | null;
      qtd: number;
      valor: number | string | null;
    }>(
      `
      SELECT
        CASE
          WHEN DATEDIFF(?, vencimento) BETWEEN 1 AND 7 THEN '1-7 dias'
          WHEN DATEDIFF(?, vencimento) BETWEEN 8 AND 30 THEN '8-30 dias'
          WHEN DATEDIFF(?, vencimento) > 30 THEN '+30 dias'
          ELSE NULL
        END AS faixa,
        COUNT(*) AS qtd,
        COALESCE(SUM(valor), 0) AS valor
      FROM cobrancas
      WHERE user_id = ? AND status = 'VENCIDO'
      GROUP BY faixa
      HAVING faixa IS NOT NULL
      ORDER BY
        CASE faixa
          WHEN '1-7 dias' THEN 1
          WHEN '8-30 dias' THEN 2
          WHEN '+30 dias' THEN 3
          ELSE 4
        END
      `,
      [todayLocal, todayLocal, todayLocal, userId]
    ),
    db.all<{
      cliente_id: number;
      cliente_nome: string;
      cliente_telefone: string;
      total_vencido: number | string | null;
      vencimento_mais_antigo: string;
      total_cobrancas: number;
    }>(
      `
      SELECT
        cliente_id,
        cliente_nome,
        cliente_telefone,
        COALESCE(SUM(valor), 0) AS total_vencido,
        MIN(vencimento) AS vencimento_mais_antigo,
        COUNT(*) AS total_cobrancas
      FROM cobrancas
      WHERE user_id = ? AND status = 'VENCIDO'
      GROUP BY cliente_id, cliente_nome, cliente_telefone
      HAVING total_vencido > 500
      ORDER BY total_vencido DESC, vencimento_mais_antigo ASC
      LIMIT 5
      `,
      [userId]
    ),
    db.get<{
      valor_vencido_total: number | string | null;
      total_clientes_inadimplentes: number;
      total_cobrancas_vencidas: number;
    }>(
      `
      SELECT
        COALESCE(SUM(valor), 0) AS valor_vencido_total,
        COUNT(DISTINCT cliente_id) AS total_clientes_inadimplentes,
        COUNT(*) AS total_cobrancas_vencidas
      FROM cobrancas
      WHERE user_id = ? AND status = 'VENCIDO'
      `,
      [userId]
    ),
  ]);

  const mrr = ensureMoney(mrrRow?.mrr);
  const valorVencidoTotal = ensureMoney(overdueRow?.valor_vencido_total);
  const inadimplenciaPercentual =
    mrr > 0
      ? Math.round((valorVencidoTotal / mrr) * 1000) / 10
      : valorVencidoTotal > 0
        ? 100
        : 0;
  const healthLevel = getFinancialHealthLevel(inadimplenciaPercentual);

  return {
    mrr,
    recorrencias_ativas: ensureNumber(mrrRow?.recorrencias_ativas),
    churn: {
      total: ensureNumber(churnRow?.total),
      valor: ensureMoney(churnRow?.valor),
      mes: mesAtual,
    },
    aging: (agingRows || [])
      .filter((row) => Boolean(row.faixa))
      .map((row) => ({
        faixa: row.faixa as FinancialHealthAgingBucket["faixa"],
        qtd: ensureNumber(row.qtd),
        valor: ensureMoney(row.valor),
      })),
    alertas: (alertRows || []).map((row) => ({
      cliente_id: ensureNumber(row.cliente_id),
      cliente_nome: row.cliente_nome,
      cliente_telefone: row.cliente_telefone,
      total_vencido: ensureMoney(row.total_vencido),
      vencimento_mais_antigo: row.vencimento_mais_antigo,
      dias_em_atraso: Math.max(1, diffDays(row.vencimento_mais_antigo, todayLocal)),
      total_cobrancas: ensureNumber(row.total_cobrancas),
    })),
    valor_vencido_total: valorVencidoTotal,
    inadimplencia_percentual: inadimplenciaPercentual,
    total_clientes_inadimplentes: ensureNumber(
      overdueRow?.total_clientes_inadimplentes
    ),
    total_cobrancas_vencidas: ensureNumber(overdueRow?.total_cobrancas_vencidas),
    health_level: healthLevel,
    health_label: getFinancialHealthLabel(healthLevel),
  };
}

export function buildFinancialHealthReport(
  operatorName: string,
  health: FinancialHealthData
) {
  const statusEmoji =
    health.health_level === "green"
      ? "🟢"
      : health.health_level === "yellow"
        ? "🟡"
        : "🔴";

  const agingLines = health.aging.length
    ? health.aging.map(
        (bucket) =>
          `• ${bucket.faixa}: ${bucket.qtd} cobrança(s) | ${formatCurrency(bucket.valor)}`
      )
    : ["• Sem cobranças vencidas nesta semana"];

  const alertLines = health.alertas.length
    ? health.alertas.map(
        (alerta, index) =>
          `${index + 1}. ${alerta.cliente_nome} — ${formatCurrency(
            alerta.total_vencido
          )} (${alerta.dias_em_atraso} dia(s) de atraso)`
      )
    : ["• Nenhum cliente crítico acima do limite configurado"];

  return [
    "📊 *Saúde Financeira da Semana*",
    "",
    `Olá, ${firstName(operatorName || "operador")}!`,
    `${statusEmoji} *Status geral:* ${health.health_label}`,
    `📈 *MRR ativo:* ${formatCurrency(health.mrr)}`,
    `⚠️ *Inadimplência:* ${formatCurrency(health.valor_vencido_total)} (${health.inadimplencia_percentual.toFixed(1)}% do MRR)`,
    `🔁 *Recorrências ativas:* ${health.recorrencias_ativas}`,
    `📉 *Churn do mês:* ${health.churn.total} cancelamento(s) | ${formatCurrency(health.churn.valor)}`,
    `👥 *Clientes inadimplentes:* ${health.total_clientes_inadimplentes}`,
    "",
    "*Aging do atraso*",
    ...agingLines,
    "",
    "*Alertas prioritários*",
    ...alertLines,
    "",
    "Abra o dashboard de cobranças para agir rápido nos casos críticos.",
  ].join("\n");
}

function extractHostDevicePhone(hostDevice: any) {
  const candidates = [
    hostDevice?.phone,
    hostDevice?.id?.user,
    hostDevice?.id?._serialized,
    hostDevice?.wid?.user,
    hostDevice?.wid?._serialized,
    hostDevice?.me?.user,
    hostDevice?.me?._serialized,
    hostDevice?.lid?.user,
    hostDevice?.lid?._serialized,
  ];

  for (const candidate of candidates) {
    const digits = onlyDigits(candidate);
    if (digits.length >= 10 && digits.length <= 15) {
      return digits;
    }
  }

  return null;
}

async function resolveOperatorOwnChatId(client: any) {
  if (typeof client?.getHostDevice !== "function") {
    return null;
  }

  try {
    const hostDevice = await Promise.resolve(client.getHostDevice());
    const phone = extractHostDevicePhone(hostDevice);
    if (!phone) {
      return null;
    }

    return await ensureChat(client, phone);
  } catch {
    return null;
  }
}

export async function sendPendingWeeklyFinancialHealthReports(): Promise<void> {
  const db = getDB();
  const users = await db.all<{
    id: number;
    name: string | null;
    timezone_offset: number | null;
  }>(
    `
    SELECT DISTINCT
      u.id,
      u.name,
      u.timezone_offset
    FROM users u
    INNER JOIN sessions s
      ON s.user_id = u.id
     AND s.status = 'connected'
    WHERE EXISTS (
      SELECT 1
      FROM cobrancas c
      WHERE c.user_id = u.id
      LIMIT 1
    )
       OR EXISTS (
      SELECT 1
      FROM cobrancas_recorrencias cr
      WHERE cr.user_id = u.id
      LIMIT 1
    )
    ORDER BY u.id ASC
    `,
    []
  );

  for (const user of users) {
    if (!isUserLocalMonday(user.timezone_offset)) {
      continue;
    }

    const weekKey = getUserLocalWeekKey(user.timezone_offset);
    const existing = await db.get<{ id: number }>(
      `
      SELECT id
      FROM audit_logs
      WHERE user_id = ?
        AND action = 'financial_health_weekly_report_sent'
        AND entity_type = 'cobrancas'
        AND entity_id = ?
      LIMIT 1
      `,
      [user.id, weekKey]
    );

    if (existing) {
      continue;
    }

    try {
      const resolved = await resolveNotificationClient(user.id);
      if (!resolved) {
        continue;
      }

      const chatId = await resolveOperatorOwnChatId(resolved.client);
      if (!chatId) {
        continue;
      }

      const health = await getFinancialHealth(user.id);
      const report = buildFinancialHealthReport(user.name || "Operador", health);

      await resolved.client.sendText(chatId, report);
      await db.run(
        `
        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, meta, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          user.id,
          "financial_health_weekly_report_sent",
          "cobrancas",
          weekKey,
          JSON.stringify({
            health_level: health.health_level,
            inadimplencia_percentual: health.inadimplencia_percentual,
            session_name: resolved.sessionName,
          }),
          nowMs(),
        ]
      );
      await logAudit(
        "financial_health_weekly_report_ack",
        user.id,
        "cobrancas",
        weekKey,
        {
          session_name: resolved.sessionName,
          mrr: health.mrr,
          valor_vencido_total: health.valor_vencido_total,
        }
      );
    } catch (error) {
      console.warn(
        `Falha ao enviar relatório semanal de saúde financeira para o usuário ${user.id}:`,
        error
      );
    }
  }
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
    link_pagamento: cobranca.mp_checkout_url || cobranca.link_pagamento || "",
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
  tipo: ChargeMessageType,
  options: {
    templateOverride?: string | null;
    updateNotificationFlags?: boolean;
  } = {}
): Promise<{ ok: boolean; error?: string }> {
  const charge = mapCobranca(cobranca as unknown as CobrancaRow);
  const db = getDB();
  let resolvedSessionName = charge.session_name || null;

  try {
    const userPreferences = await loadUserChargePreferences(userId);
    const resolved = await resolveNotificationClient(userId, charge.session_name);
    resolvedSessionName = resolved?.sessionName || resolvedSessionName;
    if (!resolved) {
      const failure = buildChargeWhatsappFailureSnapshot({
        tipo,
        sessionName: resolvedSessionName,
        error: "Nenhuma sessão WPP conectada",
      });

      await db.run(
        `
        UPDATE cobrancas
        SET
          session_name = ?,
          whatsapp_ultimo_tipo = ?,
          whatsapp_ultimo_status = ?,
          whatsapp_ultimo_ack = ?,
          whatsapp_ultima_mensagem_id = NULL,
          whatsapp_ultimo_erro = ?,
          whatsapp_ultimo_envio_em = NULL,
          whatsapp_ultimo_entregue_em = NULL,
          whatsapp_ultimo_lido_em = NULL,
          whatsapp_ultimo_status_em = ?,
          updated_at = ?
        WHERE id = ?
        `,
        [
          failure.sessionName,
          failure.tipo,
          failure.status,
          failure.ack,
          failure.error,
          failure.statusAt,
          failure.statusAt,
          charge.id,
        ]
      );

      emitToUser(userId, "cobranca:atualizada", {
        id: charge.id,
        whatsapp_ultimo_status: "FAILED",
        whatsapp_ultimo_tipo: tipo,
      });
    }
    if (!resolved) {
      return { ok: false, error: "Nenhuma sessão WPP conectada" };
    }

    const phone = normalizePhone(charge.cliente_telefone);
    const chatId = await ensureChat(resolved.client, phone);
    const message = buildMensagemCobranca(
      charge,
      tipo,
      {
        ...userPreferences.templates,
        ...(options.templateOverride
          ? { [tipo]: options.templateOverride }
          : {}),
      }
    );

    const sentMessage = await resolved.client.sendText(chatId, message);
    const trackedAt = nowMs();
    const ackValue = normalizeChargeWhatsappAckValue((sentMessage as any)?.ack) ?? 1;
    const messageId = normalizeChargeWhatsappMessageId((sentMessage as any)?.id);
    const deliveryStatus = getChargeWhatsappDeliveryStatusFromAck(ackValue);
    const deliveredAt = ackValue >= 2 ? trackedAt : null;
    const readAt = ackValue >= 3 ? trackedAt : null;

    const updates: string[] = [
      "session_name = ?",
      "whatsapp_ultimo_tipo = ?",
      "whatsapp_ultimo_status = ?",
      "whatsapp_ultimo_ack = ?",
      "whatsapp_ultima_mensagem_id = ?",
      "whatsapp_ultimo_erro = NULL",
      "whatsapp_ultimo_envio_em = ?",
      "whatsapp_ultimo_entregue_em = ?",
      "whatsapp_ultimo_lido_em = ?",
      "whatsapp_ultimo_status_em = ?",
      "updated_at = ?",
    ];
    const params: any[] = [
      resolved.sessionName,
      tipo,
      deliveryStatus,
      ackValue,
      messageId,
      trackedAt,
      deliveredAt,
      readAt,
      trackedAt,
      trackedAt,
    ];

    if (options.updateNotificationFlags !== false) {
      if (tipo === "criacao") {
        updates.push("notificado_criacao = 1");
      } else if (tipo === "lembrete_vencimento") {
        updates.push("notificado_vencimento = 1");
      } else if (tipo === "atraso") {
        updates.push("notificado_atraso = 1");
      } else if (tipo === "confirmacao_pagamento") {
        updates.push("notificado_confirmacao_pagamento = 1");
      }
    }

    params.push(charge.id);

    try {
      await db.run(
        `
        UPDATE cobrancas
        SET ${updates.join(", ")}
        WHERE id = ?
        `,
        params
      );
    } catch (trackingError) {
      console.error(
        "Erro ao registrar status de envio da cobrança no WhatsApp:",
        trackingError
      );
    }

    emitToUser(userId, "cobranca:atualizada", {
      id: charge.id,
      whatsapp_ultimo_status: deliveryStatus,
      whatsapp_ultimo_tipo: tipo,
    });

    return { ok: true };
  } catch (error) {
    const friendlyError = getFriendlyChargeWhatsappError(error);

    try {
      const failure = buildChargeWhatsappFailureSnapshot({
        tipo,
        sessionName: resolvedSessionName,
        error: friendlyError,
      });

      await db.run(
        `
        UPDATE cobrancas
        SET
          session_name = ?,
          whatsapp_ultimo_tipo = ?,
          whatsapp_ultimo_status = ?,
          whatsapp_ultimo_ack = ?,
          whatsapp_ultima_mensagem_id = NULL,
          whatsapp_ultimo_erro = ?,
          whatsapp_ultimo_envio_em = NULL,
          whatsapp_ultimo_entregue_em = NULL,
          whatsapp_ultimo_lido_em = NULL,
          whatsapp_ultimo_status_em = ?,
          updated_at = ?
        WHERE id = ?
        `,
        [
          failure.sessionName,
          failure.tipo,
          failure.status,
          failure.ack,
          failure.error,
          failure.statusAt,
          failure.statusAt,
          charge.id,
        ]
      );
    } catch (trackingError) {
      console.error(
        "Erro ao registrar falha de envio da cobrança no WhatsApp:",
        trackingError
      );
    }

    emitToUser(userId, "cobranca:atualizada", {
      id: charge.id,
      whatsapp_ultimo_status: "FAILED",
      whatsapp_ultimo_tipo: tipo,
    });
    console.error("Erro ao enviar notificação de cobrança via WhatsApp:", error);
    return {
      ok: false,
      error: friendlyError,
    };
  }
}
