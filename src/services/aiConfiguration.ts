export const AI_CONFIG_VERSION = 1;
export const AI_CONFIG_PROMPT_MAX_CHARS = 4000;

export type AiConfiguration = {
  version: number;
  assistantName: string;
  companyName: string;
  role: string;
  personalityTone: string;
  mainObjective: string;
  companyContext: string;
  productsServices: string;
  faq: string;
  additionalContext: string;
  greeting: string;
  serviceFlow: string;
  leadQualification: string;
  commercialRules: string;
  objections: string;
  availability: string;
  bookingRules: string;
  calendarInstructions: string;
  handoffConditions: string;
  handoffMessage: string;
  restrictions: string;
  closing: string;
  advancedInstructions: string;
};

const CONFIG_FIELDS = [
  "assistantName",
  "companyName",
  "role",
  "personalityTone",
  "mainObjective",
  "companyContext",
  "productsServices",
  "faq",
  "additionalContext",
  "greeting",
  "serviceFlow",
  "leadQualification",
  "commercialRules",
  "objections",
  "availability",
  "bookingRules",
  "calendarInstructions",
  "handoffConditions",
  "handoffMessage",
  "restrictions",
  "closing",
  "advancedInstructions",
] as const;

const FIELD_MAX_CHARS = 2_000;

function cleanValue(value: unknown): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, FIELD_MAX_CHARS);
}

export function createEmptyAiConfiguration(): AiConfiguration {
  return {
    version: AI_CONFIG_VERSION,
    assistantName: "",
    companyName: "",
    role: "",
    personalityTone: "",
    mainObjective: "",
    companyContext: "",
    productsServices: "",
    faq: "",
    additionalContext: "",
    greeting: "",
    serviceFlow: "",
    leadQualification: "",
    commercialRules: "",
    objections: "",
    availability: "",
    bookingRules: "",
    calendarInstructions: "",
    handoffConditions: "",
    handoffMessage: "",
    restrictions: "",
    closing: "",
    advancedInstructions: "",
  };
}

export function normalizeAiConfiguration(value: unknown): AiConfiguration {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const config = createEmptyAiConfiguration();

  for (const field of CONFIG_FIELDS) {
    config[field] = cleanValue(raw[field]);
  }

  return config;
}

export function parseAiConfiguration(value: unknown): AiConfiguration | null {
  if (!value) return null;

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normalizeAiConfiguration(parsed);
  } catch {
    return null;
  }
}

function addSection(sections: string[], title: string, items: Array<[string, string]>) {
  const filledItems = items.filter(([, value]) => value);
  if (!filledItems.length) return;

  sections.push([
    title,
    ...filledItems.map(([label, value]) => `- ${label}: ${value}`),
  ].join("\n"));
}

/**
 * Mantém o formato de prompt que o mecanismo de IA já conhece, mas o gera no
 * servidor a partir de campos amigáveis do painel.
 */
export function buildPromptFromAiConfiguration(config: AiConfiguration): string {
  const sections: string[] = [];

  addSection(sections, "IDENTIDADE", [
    ["Nome da assistente", config.assistantName],
    ["Empresa", config.companyName],
    ["Papel", config.role],
    ["Personalidade e tom", config.personalityTone],
  ]);
  addSection(sections, "OBJETIVO", [["Objetivo principal", config.mainObjective]]);
  addSection(sections, "CONHECIMENTO", [
    ["Sobre a empresa", config.companyContext],
    ["Produtos e serviços", config.productsServices],
    ["Perguntas frequentes", config.faq],
    ["Contexto adicional", config.additionalContext],
  ]);
  addSection(sections, "ATENDIMENTO", [
    ["Saudação inicial", config.greeting],
    ["Fluxo de atendimento", config.serviceFlow],
    ["Qualificação de leads", config.leadQualification],
  ]);
  addSection(sections, "VENDAS", [
    ["Regras comerciais", config.commercialRules],
    ["Objeções e respostas", config.objections],
  ]);
  addSection(sections, "AGENDAMENTO", [
    ["Disponibilidade", config.availability],
    ["Regras para agendar", config.bookingRules],
    ["Calendário e confirmações", config.calendarInstructions],
  ]);
  addSection(sections, "ATENDIMENTO HUMANO", [
    ["Quando transferir", config.handoffConditions],
    ["Mensagem de transferência", config.handoffMessage],
  ]);
  addSection(sections, "SEGURANÇA E COMPORTAMENTO", [
    ["Restrições", config.restrictions],
    ["Encerramento", config.closing],
    ["Instruções adicionais", config.advancedInstructions],
  ]);

  const prompt = [
    "Siga as instruções abaixo para atender clientes. Responda de forma útil, clara e respeitosa. Não invente informações ausentes.",
    ...sections,
  ].join("\n\n").trim();

  return prompt.slice(0, AI_CONFIG_PROMPT_MAX_CHARS).trim();
}
