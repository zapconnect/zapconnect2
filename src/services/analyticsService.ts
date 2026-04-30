import { GoogleGenerativeAI } from "@google/generative-ai";
import { getDB } from "../database";
import { decodeCompressedJson } from "../utils/chatHistoryCodec";

const DAY_MS = 24 * 60 * 60 * 1000;
const ANALYTICS_WINDOW_MS = DAY_MS;
const ANALYTICS_MODEL_ID =
  process.env.GEMINI_ANALYTICS_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash-lite";
const ANALYTICS_MAX_CONVERSATIONS = Math.max(
  10,
  Number(process.env.ANALYTICS_MAX_CONVERSATIONS || 40)
);
const ANALYTICS_MAX_TURNS = Math.max(
  8,
  Number(process.env.ANALYTICS_MAX_TURNS || 18)
);
const ANALYTICS_MAX_TOTAL_CHARS = Math.max(
  12_000,
  Number(process.env.ANALYTICS_MAX_TOTAL_CHARS || 48_000)
);
const ANALYTICS_MAX_THEME_ITEMS = 5;
const ANALYTICS_MAX_UNANSWERED_ITEMS = 5;
const ANALYTICS_MAX_SUGGESTION_ITEMS = 4;
const ANALYTICS_REFRESH_MIN_AGE_MS = Math.max(
  15 * 60 * 1000,
  Number(process.env.ANALYTICS_REFRESH_MIN_AGE_MS || 6 * 60 * 60 * 1000)
);
const FREE_ANALYTICS_HISTORY_DAYS = 7;
const PRO_ANALYTICS_HISTORY_DAYS = Math.max(
  FREE_ANALYTICS_HISTORY_DAYS,
  Number(process.env.ANALYTICS_PRO_HISTORY_DAYS || 365)
);

const analyticsClient = process.env.GEMINI_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_KEY)
  : null;

type ChatHistoryEntry = {
  role: "user" | "model";
  parts?: Array<{ text?: string | null }>;
};

type AnalyticsReportRow = {
  id: number;
  user_id: number;
  report_date: string;
  window_start: number;
  window_end: number;
  data: string | null;
  created_at_ms: number | string | null;
  updated_at_ms: number | string | null;
};

type ChatHistoryRow = {
  id: number;
  chat_id: string;
  session_name: string | null;
  history: Buffer | string | null;
  updated_at_ms: number | string | null;
};

type TranscriptConversation = {
  chatId: string;
  sessionName: string | null;
  updatedAt: number;
  transcript: string;
  turns: number;
  userMessages: string[];
  modelMessages: string[];
  questionCandidates: UnansweredCandidate[];
  negativeSignals: number;
  positiveSignals: number;
};

type UnansweredCandidate = {
  question: string;
  reason: string;
  chatId: string;
  occurrences: number;
};

export type AnalyticsTheme = {
  topic: string;
  count: number;
  share: number;
  summary: string;
};

export type AnalyticsQuestion = {
  question: string;
  occurrences: number;
  reason: string;
  chatId: string | null;
};

export type AnalyticsPromptSuggestion = {
  title: string;
  suggestion: string;
  why: string;
  priority: "high" | "medium" | "low";
};

export type AnalyticsPeakHour = {
  hour: number;
  label: string;
  count: number;
};

export type AnalyticsReportData = {
  version: number;
  generatedAt: number;
  model: string | null;
  summary: string;
  themes: AnalyticsTheme[];
  satisfaction: {
    score: number;
    label: string;
    summary: string;
    positive: number;
    neutral: number;
    negative: number;
  };
  peakHours: AnalyticsPeakHour[];
  unansweredQuestions: AnalyticsQuestion[];
  promptSuggestions: AnalyticsPromptSuggestion[];
  risks: string[];
  notes: string[];
  source: {
    windowStart: number;
    windowEnd: number;
    conversationsAnalyzed: number;
    estimatedMessages: number;
    truncatedByConversationLimit: boolean;
    truncatedByTokenBudget: boolean;
    fallbackUsed: boolean;
  };
};

export type AnalyticsReport = {
  id: number;
  userId: number;
  reportDate: string;
  windowStart: number;
  windowEnd: number;
  createdAt: number;
  updatedAt: number;
  data: AnalyticsReportData;
};

export type AnalyticsAccess = {
  plan: "free" | "starter" | "pro";
  canExportPdf: boolean;
  maxHistoryDays: number;
  fullHistoryEnabled: boolean;
};

const POSITIVE_PATTERNS = [
  /\bobrigad[oa]\b/i,
  /\bperfeito\b/i,
  /\bexcelente\b/i,
  /\btop\b/i,
  /\bótim[oa]\b/i,
  /\bshow\b/i,
  /\bvaleu\b/i,
  /\bresolvid[oa]\b/i,
  /\bgostei\b/i,
];

const NEGATIVE_PATTERNS = [
  /\berro\b/i,
  /\bproblema\b/i,
  /\bdemor[ao]\b/i,
  /\bfrustr/i,
  /\bn[aã]o funciona\b/i,
  /\bn[aã]o responde\b/i,
  /\btrav/i,
  /\bcancel/i,
  /\binsatis/i,
  /\bruim\b/i,
  /\bp[ée]ssim/i,
];

const GENERIC_ANSWER_PATTERNS = [
  /tente novamente/i,
  /n[aã]o consegui/i,
  /n[aã]o entendi/i,
  /erro inesperado/i,
  /temporariamente indispon/i,
  /a ia demorou/i,
  /pode reformular/i,
  /sem resposta/i,
];

const STOPWORDS = new Set(
  [
    "a",
    "ao",
    "aos",
    "as",
    "até",
    "com",
    "como",
    "da",
    "das",
    "de",
    "dela",
    "dele",
    "deles",
    "depois",
    "do",
    "dos",
    "e",
    "ela",
    "ele",
    "em",
    "entre",
    "era",
    "essa",
    "esse",
    "esta",
    "está",
    "eu",
    "foi",
    "isso",
    "já",
    "la",
    "mais",
    "me",
    "meu",
    "minha",
    "muito",
    "na",
    "não",
    "nem",
    "no",
    "nos",
    "o",
    "os",
    "ou",
    "para",
    "por",
    "pra",
    "que",
    "se",
    "sem",
    "ser",
    "seu",
    "sua",
    "tem",
    "tenho",
    "um",
    "uma",
    "vou",
  ].map((item) =>
    item
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
  )
);

function clipText(value: unknown, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function toSafeInt(value: unknown, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function normalizePlan(plan: unknown): AnalyticsAccess["plan"] {
  const safe = String(plan || "").trim().toLowerCase();
  if (safe === "starter") return "starter";
  if (safe === "pro") return "pro";
  return "free";
}

export function getAnalyticsAccess(plan: unknown): AnalyticsAccess {
  const normalizedPlan = normalizePlan(plan);
  if (normalizedPlan === "pro") {
    return {
      plan: normalizedPlan,
      canExportPdf: true,
      maxHistoryDays: PRO_ANALYTICS_HISTORY_DAYS,
      fullHistoryEnabled: true,
    };
  }

  return {
    plan: normalizedPlan,
    canExportPdf: false,
    maxHistoryDays: FREE_ANALYTICS_HISTORY_DAYS,
    fullHistoryEnabled: false,
  };
}

export function clampAnalyticsDays(days: unknown, access: AnalyticsAccess) {
  const requested = Number(days);
  if (!Number.isFinite(requested)) return access.maxHistoryDays;
  return Math.max(1, Math.min(access.maxHistoryDays, Math.floor(requested)));
}

export function formatReportDateForOffset(
  timestampMs: number,
  timezoneOffsetMinutes = -180
) {
  const local = new Date(timestampMs + timezoneOffsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatHourLabel(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatDateTimeBr(timestamp: number) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function normalizeToken(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function parseReportData(raw: string | null | undefined): AnalyticsReportData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AnalyticsReportData;
  } catch {
    return null;
  }
}

function normalizeReportDateValue(value: unknown) {
  if (!value) return "";

  if (value instanceof Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const text = String(value).trim();
  const isoDateMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) return isoDateMatch[1];

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getUTCFullYear();
    const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    const day = String(parsed.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return text;
}

function hydrateReport(row: AnalyticsReportRow): AnalyticsReport | null {
  const data = parseReportData(row.data);
  if (!data) return null;

  return {
    id: toSafeInt(row.id),
    userId: toSafeInt(row.user_id),
    reportDate: normalizeReportDateValue(row.report_date),
    windowStart: toSafeInt(row.window_start),
    windowEnd: toSafeInt(row.window_end),
    createdAt: toSafeInt(row.created_at_ms),
    updatedAt: toSafeInt(row.updated_at_ms),
    data,
  };
}

function extractEntryText(entry: ChatHistoryEntry | null | undefined) {
  const text = (entry?.parts || [])
    .map((part) => String(part?.text || ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function countPatternMatches(patterns: RegExp[], messages: string[]) {
  let total = 0;
  for (const message of messages) {
    if (patterns.some((pattern) => pattern.test(message))) {
      total += 1;
    }
  }
  return total;
}

function normalizeQuestionKey(question: string) {
  return normalizeToken(question)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectUnansweredCandidates(
  history: ChatHistoryEntry[],
  chatId: string
): UnansweredCandidate[] {
  const candidates: UnansweredCandidate[] = [];

  for (let index = 0; index < history.length; index += 1) {
    const current = history[index];
    if (!current || current.role !== "user") continue;

    const question = extractEntryText(current);
    if (!question || !/[?？]/.test(question)) continue;

    let nextModelReply = "";
    for (let inner = index + 1; inner < history.length; inner += 1) {
      const next = history[inner];
      if (next?.role === "model") {
        nextModelReply = extractEntryText(next);
        break;
      }
    }

    const genericReply =
      !nextModelReply ||
      nextModelReply.length < 18 ||
      GENERIC_ANSWER_PATTERNS.some((pattern) => pattern.test(nextModelReply));

    if (!genericReply) continue;

    candidates.push({
      question: clipText(question, 180),
      reason: nextModelReply
        ? `Resposta genérica do bot: "${clipText(nextModelReply, 120)}"`
        : "Pergunta sem resposta do bot na janela analisada",
      chatId,
      occurrences: 1,
    });
  }

  return candidates;
}

function buildTranscriptConversation(
  row: ChatHistoryRow,
  history: ChatHistoryEntry[]
): TranscriptConversation | null {
  const trimmed = Array.isArray(history)
    ? history.slice(-ANALYTICS_MAX_TURNS)
    : [];

  if (!trimmed.length) return null;

  const lines: string[] = [];
  const userMessages: string[] = [];
  const modelMessages: string[] = [];

  for (const entry of trimmed) {
    const text = extractEntryText(entry);
    if (!text) continue;

    if (entry.role === "user") {
      userMessages.push(text);
      lines.push(`Cliente: ${text}`);
    } else {
      modelMessages.push(text);
      lines.push(`Bot: ${text}`);
    }
  }

  if (!lines.length) return null;

  const questionCandidates = collectUnansweredCandidates(trimmed, row.chat_id);
  const negativeSignals = countPatternMatches(NEGATIVE_PATTERNS, userMessages);
  const positiveSignals = countPatternMatches(POSITIVE_PATTERNS, userMessages);

  return {
    chatId: row.chat_id,
    sessionName: row.session_name,
    updatedAt: toSafeInt(row.updated_at_ms),
    transcript: lines.join("\n"),
    turns: lines.length,
    userMessages,
    modelMessages,
    questionCandidates,
    negativeSignals,
    positiveSignals,
  };
}

function buildFallbackThemes(conversations: TranscriptConversation[]): AnalyticsTheme[] {
  const tokenCount = new Map<string, number>();

  for (const conversation of conversations) {
    for (const message of conversation.userMessages) {
      const normalized = normalizeToken(message);
      const tokens = normalized.match(/[\p{L}\p{N}]{3,}/gu) || [];
      for (const token of tokens) {
        if (STOPWORDS.has(token)) continue;
        tokenCount.set(token, (tokenCount.get(token) || 0) + 1);
      }
    }
  }

  const total = Math.max(conversations.length, 1);

  return Array.from(tokenCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, ANALYTICS_MAX_THEME_ITEMS)
    .map(([topic, count]) => ({
      topic,
      count,
      share: Number((count / total).toFixed(2)),
      summary: `Tema recorrente citado em ${count} interação(ões).`,
    }));
}

function mergeQuestionCandidates(
  conversations: TranscriptConversation[]
): AnalyticsQuestion[] {
  const grouped = new Map<string, AnalyticsQuestion>();

  for (const conversation of conversations) {
    for (const candidate of conversation.questionCandidates) {
      const key = normalizeQuestionKey(candidate.question);
      if (!key) continue;

      const existing = grouped.get(key);
      if (existing) {
        existing.occurrences += candidate.occurrences;
        continue;
      }

      grouped.set(key, {
        question: candidate.question,
        occurrences: candidate.occurrences,
        reason: candidate.reason,
        chatId: candidate.chatId,
      });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, ANALYTICS_MAX_UNANSWERED_ITEMS);
}

function buildPeakHours(
  conversations: TranscriptConversation[],
  timezoneOffsetMinutes = -180
): AnalyticsPeakHour[] {
  const counters = new Map<number, number>();

  for (const conversation of conversations) {
    const shifted = new Date(conversation.updatedAt + timezoneOffsetMinutes * 60_000);
    const hour = shifted.getUTCHours();
    counters.set(hour, (counters.get(hour) || 0) + 1);
  }

  return Array.from(counters.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] - b[0];
    })
    .slice(0, 6)
    .map(([hour, count]) => ({
      hour,
      label: formatHourLabel(hour),
      count,
    }));
}

function buildFallbackSatisfaction(conversations: TranscriptConversation[]) {
  const positive = conversations.reduce(
    (sum, item) => sum + item.positiveSignals,
    0
  );
  const negative = conversations.reduce(
    (sum, item) => sum + item.negativeSignals,
    0
  );
  const totalSignals = positive + negative;

  let score = 68;
  if (totalSignals > 0) {
    score = Math.round((positive / totalSignals) * 100);
  }

  const neutral = Math.max(conversations.length - positive - negative, 0);
  const label =
    score >= 75 ? "Alta" : score >= 55 ? "Moderada" : "Em risco";
  const summary =
    score >= 75
      ? "Os sinais recentes apontam boa receptividade nas conversas."
      : score >= 55
        ? "Há equilíbrio entre sinais positivos e pontos de atrito."
        : "O volume de sinais negativos pede ajustes no fluxo do bot.";

  return {
    score,
    label,
    summary,
    positive,
    neutral,
    negative,
  };
}

function buildFallbackSuggestions(
  unansweredQuestions: AnalyticsQuestion[],
  satisfaction: AnalyticsReportData["satisfaction"],
  themes: AnalyticsTheme[]
): AnalyticsPromptSuggestion[] {
  const suggestions: AnalyticsPromptSuggestion[] = [];

  if (unansweredQuestions.length) {
    suggestions.push({
      title: "Cobrir lacunas frequentes",
      suggestion:
        "Inclua no prompt uma seção com respostas claras para as perguntas que ficaram sem resposta e instrua o bot a pedir contexto mínimo antes de desistir.",
      why: "O relatório encontrou perguntas recorrentes sem retorno convincente.",
      priority: "high",
    });
  }

  if (satisfaction.score < 60) {
    suggestions.push({
      title: "Escalada mais rápida",
      suggestion:
        "Adicione uma regra de fallback para transferir ao humano após sinais de frustração, demora ou repetição do mesmo tema.",
      why: "A satisfação estimada caiu e há indícios de atrito nas conversas.",
      priority: "high",
    });
  }

  if (themes.length) {
    suggestions.push({
      title: "Especializar respostas do nicho",
      suggestion: `Reforce no prompt exemplos e respostas padrão sobre "${themes[0].topic}" para reduzir improviso do bot.`,
      why: "Esse é o assunto mais frequente no período.",
      priority: "medium",
    });
  }

  if (!suggestions.length) {
    suggestions.push({
      title: "Manter monitoramento",
      suggestion:
        "Continue acompanhando os relatórios diários e adicione exemplos reais de conversas bem-sucedidas ao prompt.",
      why: "O período analisado não mostrou falhas críticas, mas exemplos reais ajudam a estabilizar a IA.",
      priority: "low",
    });
  }

  return suggestions.slice(0, ANALYTICS_MAX_SUGGESTION_ITEMS);
}

function buildSummaryText(input: {
  themes: AnalyticsTheme[];
  satisfaction: AnalyticsReportData["satisfaction"];
  unansweredQuestions: AnalyticsQuestion[];
  peakHours: AnalyticsPeakHour[];
}) {
  const topTheme = input.themes[0]?.topic || "temas variados";
  const peakHour = input.peakHours[0]?.label || "sem pico claro";
  const unanswered = input.unansweredQuestions.length;

  return `O período foi dominado por ${topTheme}, com satisfação estimada em ${input.satisfaction.score}% e pico de atividade por volta de ${peakHour}. ${unanswered ? `Há ${unanswered} pergunta(s) crítica(s) sem boa resposta.` : "Não apareceram lacunas críticas de resposta no recorte analisado."}`;
}

function buildEmptyReportData(windowStart: number, windowEnd: number): AnalyticsReportData {
  return {
    version: 1,
    generatedAt: Date.now(),
    model: analyticsClient ? ANALYTICS_MODEL_ID : null,
    summary: "Nenhuma conversa elegível foi encontrada na janela analisada.",
    themes: [],
    satisfaction: {
      score: 0,
      label: "Sem dados",
      summary: "Ainda não há volume suficiente para estimar satisfação.",
      positive: 0,
      neutral: 0,
      negative: 0,
    },
    peakHours: [],
    unansweredQuestions: [],
    promptSuggestions: [
      {
        title: "Aguardar volume",
        suggestion:
          "Assim que houver novas conversas com IA, o relatório passará a mostrar temas, atritos e oportunidades de melhoria.",
        why: "Não houve material suficiente para análise neste período.",
        priority: "low",
      },
    ],
    risks: [],
    notes: ["Sem conversas recentes nas últimas 24h."],
    source: {
      windowStart,
      windowEnd,
      conversationsAnalyzed: 0,
      estimatedMessages: 0,
      truncatedByConversationLimit: false,
      truncatedByTokenBudget: false,
      fallbackUsed: false,
    },
  };
}

function sanitizeTheme(raw: any, conversationsCount: number): AnalyticsTheme | null {
  const topic = clipText(raw?.topic || raw?.label || "", 80);
  if (!topic) return null;
  const count = Math.max(1, toSafeInt(raw?.count, 1));
  const shareRaw = Number(raw?.share);
  const share = Number.isFinite(shareRaw)
    ? Number(Math.max(0, Math.min(1, shareRaw)).toFixed(2))
    : Number((count / Math.max(conversationsCount, 1)).toFixed(2));

  return {
    topic,
    count,
    share,
    summary: clipText(raw?.summary || raw?.description || "", 180),
  };
}

function sanitizeQuestion(raw: any): AnalyticsQuestion | null {
  const question = clipText(raw?.question || raw?.title || "", 180);
  if (!question) return null;

  return {
    question,
    occurrences: Math.max(1, toSafeInt(raw?.occurrences ?? raw?.count, 1)),
    reason: clipText(raw?.reason || raw?.why || "Sem explicação fornecida", 180),
    chatId: raw?.chatId ? clipText(raw.chatId, 80) : null,
  };
}

function sanitizeSuggestion(raw: any): AnalyticsPromptSuggestion | null {
  const title = clipText(raw?.title || raw?.headline || "", 70);
  const suggestion = clipText(raw?.suggestion || raw?.action || "", 220);
  const why = clipText(raw?.why || raw?.reason || "", 180);
  if (!title || !suggestion) return null;

  const priorityRaw = String(raw?.priority || "").trim().toLowerCase();
  const priority =
    priorityRaw === "high" || priorityRaw === "medium" || priorityRaw === "low"
      ? priorityRaw
      : "medium";

  return {
    title,
    suggestion,
    why: why || "Sem justificativa detalhada.",
    priority,
  };
}

function sanitizeSatisfaction(raw: any, fallback: AnalyticsReportData["satisfaction"]) {
  const score = Math.max(0, Math.min(100, toSafeInt(raw?.score, fallback.score)));
  return {
    score,
    label: clipText(raw?.label || fallback.label, 30),
    summary: clipText(raw?.summary || fallback.summary, 220),
    positive: Math.max(0, toSafeInt(raw?.positive, fallback.positive)),
    neutral: Math.max(0, toSafeInt(raw?.neutral, fallback.neutral)),
    negative: Math.max(0, toSafeInt(raw?.negative, fallback.negative)),
  };
}

function extractJsonPayload(rawText: string) {
  const cleaned = String(rawText || "").trim();
  if (!cleaned) return null;

  const fenced = cleaned.match(/```json\s*([\s\S]+?)```/i);
  const candidate = fenced?.[1] || cleaned;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
  }

  return null;
}

async function analyzeWithGemini(input: {
  windowStart: number;
  windowEnd: number;
  conversations: TranscriptConversation[];
  fallbackQuestions: AnalyticsQuestion[];
  peakHours: AnalyticsPeakHour[];
}) {
  if (!analyticsClient) return null;

  const model = analyticsClient.getGenerativeModel({
    model: ANALYTICS_MODEL_ID,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  });

  const batches: string[] = [];
  let totalChars = 0;

  for (const conversation of input.conversations) {
    const chunk = [
      `CHAT_ID: ${conversation.chatId}`,
      `SESSAO: ${conversation.sessionName || "geral"}`,
      `ATUALIZADO_EM: ${formatDateTimeBr(conversation.updatedAt)}`,
      conversation.transcript,
    ].join("\n");

    if (totalChars + chunk.length > ANALYTICS_MAX_TOTAL_CHARS) break;
    batches.push(chunk);
    totalChars += chunk.length;
  }

  const prompt = [
    "Você é um analista de operações de atendimento no WhatsApp.",
    "Analise conversas das últimas 24h e retorne SOMENTE JSON válido.",
    "Não invente dados. Use contagens conservadoras.",
    "Foque em: temas recorrentes, satisfação estimada, perguntas sem boa resposta e melhorias de prompt.",
    "",
    "Formato esperado:",
    JSON.stringify(
      {
        summary: "string curta",
        themes: [
          {
            topic: "tema",
            count: 3,
            share: 0.25,
            summary: "por que esse tema importa",
          },
        ],
        satisfaction: {
          score: 72,
          label: "Alta|Moderada|Em risco",
          summary: "leitura executiva",
          positive: 5,
          neutral: 8,
          negative: 2,
        },
        unansweredQuestions: [
          {
            question: "texto da pergunta",
            occurrences: 2,
            reason: "motivo",
            chatId: "5511999999999@c.us",
          },
        ],
        promptSuggestions: [
          {
            title: "ação",
            suggestion: "texto objetivo",
            why: "impacto esperado",
            priority: "high",
          },
        ],
        risks: ["risco 1", "risco 2"],
      },
      null,
      2
    ),
    "",
    `Janela analisada: ${formatDateTimeBr(input.windowStart)} até ${formatDateTimeBr(input.windowEnd)}`,
    `Picos de atividade calculados pelo sistema: ${input.peakHours
      .map((item) => `${item.label} (${item.count})`)
      .join(", ") || "sem picos claros"}`,
    input.fallbackQuestions.length
      ? `Perguntas possivelmente sem resposta (heurística): ${JSON.stringify(
          input.fallbackQuestions
        )}`
      : "Perguntas heurísticas sem resposta: nenhuma destacada",
    "",
    "Conversas:",
    batches.join("\n\n---\n\n"),
  ].join("\n");

  const result = await model.generateContent(prompt);
  const text = result.response?.text?.() || "";
  return extractJsonPayload(text);
}

function buildAnalyticsPayload(input: {
  windowStart: number;
  windowEnd: number;
  conversations: TranscriptConversation[];
  timezoneOffsetMinutes: number;
  aiResult: any | null;
  truncatedByConversationLimit: boolean;
  truncatedByTokenBudget: boolean;
}): AnalyticsReportData {
  const fallbackThemes = buildFallbackThemes(input.conversations);
  const fallbackQuestions = mergeQuestionCandidates(input.conversations);
  const peakHours = buildPeakHours(
    input.conversations,
    input.timezoneOffsetMinutes
  );
  const fallbackSatisfaction = buildFallbackSatisfaction(input.conversations);

  const themes = Array.isArray(input.aiResult?.themes)
    ? input.aiResult.themes
        .map((item: any) =>
          sanitizeTheme(item, input.conversations.length)
        )
        .filter(Boolean)
        .slice(0, ANALYTICS_MAX_THEME_ITEMS)
    : [];

  const unansweredQuestions = Array.isArray(input.aiResult?.unansweredQuestions)
    ? input.aiResult.unansweredQuestions
        .map((item: any) => sanitizeQuestion(item))
        .filter(Boolean)
        .slice(0, ANALYTICS_MAX_UNANSWERED_ITEMS)
    : [];

  const promptSuggestions = Array.isArray(input.aiResult?.promptSuggestions)
    ? input.aiResult.promptSuggestions
        .map((item: any) => sanitizeSuggestion(item))
        .filter(Boolean)
        .slice(0, ANALYTICS_MAX_SUGGESTION_ITEMS)
    : [];

  const risks = Array.isArray(input.aiResult?.risks)
    ? input.aiResult.risks
        .map((item: any) => clipText(item, 180))
        .filter(Boolean)
        .slice(0, 5)
    : [];

  const estimatedMessages = input.conversations.reduce(
    (sum, item) => sum + item.turns,
    0
  );

  const satisfaction = sanitizeSatisfaction(
    input.aiResult?.satisfaction,
    fallbackSatisfaction
  );

  const notes: string[] = [];
  const fallbackUsed = !input.aiResult;
  if (fallbackUsed) {
    notes.push("A IA de analytics não respondeu; o relatório usou heurísticas locais.");
  }
  if (input.truncatedByConversationLimit) {
    notes.push("A amostra foi limitada para controlar custo e tempo de processamento.");
  }
  if (input.truncatedByTokenBudget) {
    notes.push("Parte das transcrições foi resumida para caber no orçamento de tokens.");
  }

  const finalThemes = themes.length ? themes : fallbackThemes;
  const finalQuestions = unansweredQuestions.length
    ? unansweredQuestions
    : fallbackQuestions;
  const finalSuggestions = promptSuggestions.length
    ? promptSuggestions
    : buildFallbackSuggestions(finalQuestions, satisfaction, finalThemes);

  return {
    version: 1,
    generatedAt: Date.now(),
    model: analyticsClient ? ANALYTICS_MODEL_ID : null,
    summary:
      clipText(input.aiResult?.summary || "", 260) ||
      buildSummaryText({
        themes: finalThemes,
        satisfaction,
        unansweredQuestions: finalQuestions,
        peakHours,
      }),
    themes: finalThemes,
    satisfaction,
    peakHours,
    unansweredQuestions: finalQuestions,
    promptSuggestions: finalSuggestions,
    risks,
    notes,
    source: {
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      conversationsAnalyzed: input.conversations.length,
      estimatedMessages,
      truncatedByConversationLimit: input.truncatedByConversationLimit,
      truncatedByTokenBudget: input.truncatedByTokenBudget,
      fallbackUsed,
    },
  };
}

async function listConversationRows(params: {
  userId: number;
  windowStart: number;
  windowEnd: number;
}) {
  const db = getDB();
  return db.all<ChatHistoryRow>(
    `
    SELECT
      id,
      chat_id,
      session_name,
      history,
      UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms
    FROM chat_histories
    WHERE user_id = ?
      AND updated_at >= FROM_UNIXTIME(?)
      AND updated_at < FROM_UNIXTIME(?)
    ORDER BY updated_at DESC
    LIMIT ?
    `,
    [
      params.userId,
      Math.floor(params.windowStart / 1000),
      Math.floor(params.windowEnd / 1000),
      ANALYTICS_MAX_CONVERSATIONS + 10,
    ]
  );
}

async function persistReport(input: {
  userId: number;
  reportDate: string;
  windowStart: number;
  windowEnd: number;
  data: AnalyticsReportData;
}) {
  const db = getDB();
  await db.run(
    `
    INSERT INTO analytics_reports (
      user_id,
      report_date,
      window_start,
      window_end,
      data
    ) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      window_start = VALUES(window_start),
      window_end = VALUES(window_end),
      data = VALUES(data),
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      input.userId,
      input.reportDate,
      input.windowStart,
      input.windowEnd,
      JSON.stringify(input.data),
    ]
  );
}

export async function getAnalyticsReportByDate(
  userId: number,
  reportDate: string
) {
  const db = getDB();
  const row = await db.get<AnalyticsReportRow>(
    `
    SELECT
      id,
      user_id,
      DATE_FORMAT(report_date, '%Y-%m-%d') AS report_date,
      window_start,
      window_end,
      data,
      UNIX_TIMESTAMP(created_at) * 1000 AS created_at_ms,
      UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms
    FROM analytics_reports
    WHERE user_id = ?
      AND report_date = ?
    LIMIT 1
    `,
    [userId, reportDate]
  );

  return row ? hydrateReport(row) : null;
}

export async function listAnalyticsReportsForUser(params: {
  userId: number;
  days: number;
}) {
  const db = getDB();
  const rows = await db.all<AnalyticsReportRow>(
    `
    SELECT
      id,
      user_id,
      DATE_FORMAT(report_date, '%Y-%m-%d') AS report_date,
      window_start,
      window_end,
      data,
      UNIX_TIMESTAMP(created_at) * 1000 AS created_at_ms,
      UNIX_TIMESTAMP(updated_at) * 1000 AS updated_at_ms
    FROM analytics_reports
    WHERE user_id = ?
      AND report_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
    ORDER BY report_date DESC
    LIMIT ?
    `,
    [params.userId, Math.max(0, params.days - 1), Math.max(1, params.days)]
  );

  return rows
    .map((row) => hydrateReport(row))
    .filter(Boolean) as AnalyticsReport[];
}

export async function hasRecentAnalyticsSourceData(
  userId: number,
  windowStart: number,
  windowEnd: number
) {
  const db = getDB();
  const row = await db.get<{ total: number }>(
    `
    SELECT COUNT(*) AS total
    FROM chat_histories
    WHERE user_id = ?
      AND updated_at >= FROM_UNIXTIME(?)
      AND updated_at < FROM_UNIXTIME(?)
    `,
    [userId, Math.floor(windowStart / 1000), Math.floor(windowEnd / 1000)]
  );
  return Number(row?.total || 0) > 0;
}

export async function generateAnalyticsReportForUser(params: {
  userId: number;
  timezoneOffsetMinutes?: number;
  reportDate?: string;
  windowStart?: number;
  windowEnd?: number;
}) {
  const timezoneOffsetMinutes = toSafeInt(params.timezoneOffsetMinutes, -180);
  const windowEnd = params.windowEnd || Date.now();
  const windowStart = params.windowStart || windowEnd - ANALYTICS_WINDOW_MS;
  const reportDate =
    params.reportDate || formatReportDateForOffset(windowEnd, timezoneOffsetMinutes);

  const rows = await listConversationRows({
    userId: params.userId,
    windowStart,
    windowEnd,
  });

  const truncatedByConversationLimit = rows.length > ANALYTICS_MAX_CONVERSATIONS;
  const limitedRows = rows.slice(0, ANALYTICS_MAX_CONVERSATIONS);
  const conversations: TranscriptConversation[] = [];

  for (const row of limitedRows) {
    if (!row.history) continue;

    try {
      const decoded = await decodeCompressedJson<ChatHistoryEntry[]>(row.history);
      if (!Array.isArray(decoded) || !decoded.length) continue;

      const conversation = buildTranscriptConversation(row, decoded);
      if (!conversation) continue;
      conversations.push(conversation);
    } catch (err) {
      console.warn("Falha ao decodificar histórico para analytics:", err);
    }
  }

  if (!conversations.length) {
    const empty = buildEmptyReportData(windowStart, windowEnd);
    await persistReport({
      userId: params.userId,
      reportDate,
      windowStart,
      windowEnd,
      data: empty,
    });
    return getAnalyticsReportByDate(params.userId, reportDate);
  }

  let totalChars = 0;
  let truncatedByTokenBudget = false;
  const budgeted: TranscriptConversation[] = [];

  for (const conversation of conversations) {
    if (totalChars + conversation.transcript.length > ANALYTICS_MAX_TOTAL_CHARS) {
      truncatedByTokenBudget = true;
      break;
    }
    budgeted.push(conversation);
    totalChars += conversation.transcript.length;
  }

  const fallbackQuestions = mergeQuestionCandidates(budgeted);

  let aiResult: any | null = null;
  try {
    aiResult = await analyzeWithGemini({
      windowStart,
      windowEnd,
      conversations: budgeted,
      fallbackQuestions,
      peakHours: buildPeakHours(budgeted, timezoneOffsetMinutes),
    });
  } catch (err) {
    console.warn("Falha no Gemini analytics, usando fallback:", err);
  }

  const payload = buildAnalyticsPayload({
    windowStart,
    windowEnd,
    conversations: budgeted,
    timezoneOffsetMinutes,
    aiResult,
    truncatedByConversationLimit,
    truncatedByTokenBudget,
  });

  await persistReport({
    userId: params.userId,
    reportDate,
    windowStart,
    windowEnd,
    data: payload,
  });

  return getAnalyticsReportByDate(params.userId, reportDate);
}

export async function ensureFreshAnalyticsReportForUser(params: {
  userId: number;
  timezoneOffsetMinutes?: number;
  minAgeMs?: number;
  force?: boolean;
}) {
  const timezoneOffsetMinutes = toSafeInt(params.timezoneOffsetMinutes, -180);
  const reportDate = formatReportDateForOffset(Date.now(), timezoneOffsetMinutes);
  const existing = await getAnalyticsReportByDate(params.userId, reportDate);

  if (!params.force && existing) {
    const age = Date.now() - existing.updatedAt;
    if (age < (params.minAgeMs || ANALYTICS_REFRESH_MIN_AGE_MS)) {
      return existing;
    }
  }

  return generateAnalyticsReportForUser({
    userId: params.userId,
    timezoneOffsetMinutes,
    reportDate,
  });
}

export function buildAnalyticsTrend(reports: AnalyticsReport[]) {
  const ordered = [...reports].sort((a, b) => a.reportDate.localeCompare(b.reportDate));

  return {
    labels: ordered.map((report) => report.reportDate),
    satisfaction: ordered.map((report) => report.data?.satisfaction?.score || 0),
    unanswered: ordered.map(
      (report) => report.data?.unansweredQuestions?.length || 0
    ),
    conversations: ordered.map(
      (report) => report.data?.source?.conversationsAnalyzed || 0
    ),
  };
}

export function renderAnalyticsReportHtml(input: {
  userName: string;
  report: AnalyticsReport;
}) {
  const { report } = input;
  const safeSummary = clipText(report.data.summary, 600);
  const peakHours = report.data.peakHours
    .map(
      (item) =>
        `<tr><td>${item.label}</td><td style="text-align:right">${item.count}</td></tr>`
    )
    .join("");
  const themes = report.data.themes
    .map(
      (item) =>
        `<tr><td>${item.topic}</td><td style="text-align:right">${item.count}</td><td style="text-align:right">${Math.round(item.share * 100)}%</td></tr>`
    )
    .join("");
  const unanswered = report.data.unansweredQuestions
    .map(
      (item) =>
        `<li><strong>${item.question}</strong><br><span>${item.reason}</span></li>`
    )
    .join("");
  const suggestions = report.data.promptSuggestions
    .map(
      (item) =>
        `<li><strong>${item.title}</strong><br><span>${item.suggestion}</span><br><em>${item.why}</em></li>`
    )
    .join("");

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>Relatório Analytics • ${input.userName}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:32px;color:#0f172a}
      h1,h2,h3{margin:0 0 12px}
      h1{font-size:28px}
      h2{font-size:18px;margin-top:28px}
      .muted{color:#475569}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}
      .card{border:1px solid #dbe3ef;border-radius:14px;padding:16px;background:#f8fafc}
      .big{font-size:32px;font-weight:700}
      table{width:100%;border-collapse:collapse;margin-top:10px}
      th,td{padding:10px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:14px}
      ul{padding-left:18px}
      li{margin-bottom:12px}
      .pill{display:inline-block;padding:4px 10px;background:#dbeafe;border-radius:999px;color:#1d4ed8;font-size:12px}
    </style>
  </head>
  <body>
    <span class="pill">ZapConnect Analytics</span>
    <h1>Relatório de Conversas com IA</h1>
    <p class="muted">Cliente: ${clipText(input.userName, 80)} • Referência: ${report.reportDate}</p>
    <p class="muted">Janela analisada: ${formatDateTimeBr(report.windowStart)} até ${formatDateTimeBr(report.windowEnd)}</p>

    <div class="grid">
      <div class="card">
        <div class="muted">Satisfação estimada</div>
        <div class="big">${report.data.satisfaction.score}%</div>
        <div>${clipText(report.data.satisfaction.label, 40)}</div>
      </div>
      <div class="card">
        <div class="muted">Conversas analisadas</div>
        <div class="big">${report.data.source.conversationsAnalyzed}</div>
        <div>${report.data.source.estimatedMessages} mensagens estimadas</div>
      </div>
      <div class="card">
        <div class="muted">Perguntas sem resposta</div>
        <div class="big">${report.data.unansweredQuestions.length}</div>
        <div>${report.data.peakHours[0]?.label || "Sem pico"}</div>
      </div>
    </div>

    <h2>Resumo Executivo</h2>
    <p>${safeSummary}</p>

    <h2>Top Assuntos</h2>
    <table>
      <thead>
        <tr><th>Assunto</th><th style="text-align:right">Ocorrências</th><th style="text-align:right">Share</th></tr>
      </thead>
      <tbody>${themes || "<tr><td colspan='3'>Sem dados</td></tr>"}</tbody>
    </table>

    <h2>Horários de Pico</h2>
    <table>
      <thead>
        <tr><th>Faixa</th><th style="text-align:right">Conversas ativas</th></tr>
      </thead>
      <tbody>${peakHours || "<tr><td colspan='2'>Sem dados</td></tr>"}</tbody>
    </table>

    <h2>Perguntas sem Resposta</h2>
    <ul>${unanswered || "<li>Nenhuma pergunta crítica encontrada.</li>"}</ul>

    <h2>Sugestões para o Prompt</h2>
    <ul>${suggestions || "<li>Nenhuma sugestão adicional.</li>"}</ul>
  </body>
  </html>`;
}
