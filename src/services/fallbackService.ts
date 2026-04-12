import { getDB } from "../database";
import { isInSilenceWindow as isInSilenceWindowUtil } from "./silenceUtils";

export type FallbackSensitivity = "low" | "medium" | "high";

export type FallbackReason =
  | "user_request"
  | "repetition_limit"
  | "frustration_limit"
  | "ai_failure"
  | "ai_uncertainty"
  | "ai_transfer"
  | "cooldown"
  | "silence_window";

export interface FallbackSettings {
  enableFallback: boolean;
  fallbackMessage: string;
  fallbackSensitivity: FallbackSensitivity;
  maxRepetitions: number;
  maxFrustration: number;
  maxIaFailures: number;
  triggerWords: string[];
  frustrationWords: string[];
  aiUncertaintyPhrases: string[];
  aiTransferPhrases: string[];
  humanModeDuration: number | null; // minutos; null/0 = sem expiração
  notifyPanel: boolean;
  notifyWebhook: boolean;
  webhookUrl: string;
  alertPhone?: string | null;
  alertMessage?: string;
  fallbackCooldownMinutes?: number | null;
}

export interface EffectiveFallbackSettings extends FallbackSettings {
  source: "db" | "default";
  limits: {
    repetition: number;
    frustration: number;
    iaFailures: number;
  };
  humanDurationMs: number | null;
  cooldownMs: number | null;
}

export interface FallbackDecision {
  shouldFallback: boolean;
  reason?: FallbackReason;
  matchedPhrase?: string;
  config: EffectiveFallbackSettings;
}

const DEFAULT_FALLBACK_SETTINGS: FallbackSettings = {
  enableFallback: true,
  fallbackMessage: "Vou encaminhar você para um atendente humano, aguarde um momento.",
  fallbackSensitivity: "medium",
  maxRepetitions: 3,
  maxFrustration: 2,
  maxIaFailures: 2,
  triggerWords: [
    "humano",
    "pessoa",
    "atendente",
    "falar com humano",
    "falar com atendente",
    "suporte humano",
  ],
  frustrationWords: [
    "reclamação",
    "reclamacao",
    "frustrado",
    "frustrada",
    "cansado",
    "cansada",
    "irritado",
    "irritada",
    "não funciona",
    "nao funciona",
    "péssimo",
    "pessimo",
    "de novo",
  ],
  aiUncertaintyPhrases: [
    "não tenho certeza",
    "nao tenho certeza",
    "não entendi",
    "nao entendi",
    "não consegui",
    "nao consegui",
    "pode fornecer mais detalhes",
    "pode repetir",
    "não sei",
    "nao sei",
  ],
  aiTransferPhrases: [
    "transferindo...",
    "vou encaminhar você para um humano",
    "vou transferir você para um atendente",
  ],
  humanModeDuration: 15,
  notifyPanel: true,
  notifyWebhook: false,
  webhookUrl: "",
  alertPhone: null,
  alertMessage: "Alerta: assuma a conversa {chatId} da sessão {sessionName}.",
  fallbackCooldownMinutes: 5,
};

type RuntimeState = {
  lastMessage: string | null;
  repetitionCount: number;
  frustrationScore: number;
  iaFailureCount: number;
  lastFrustration?: string | null;
  lastUpdated: number;
};

type CachedEntry = { value: EffectiveFallbackSettings; storedAt: number };
export const fallbackSettingsCache = new Map<string, CachedEntry>();
const runtimeByChat = new Map<string, RuntimeState>();
const lastFallbackAt = new Map<string, number>();
const silenceCache = new Map<number, { value: boolean; fetchedAt: number }>();

const LONG_AUDIO_SECONDS = 90;
const DOCUMENT_NO_TEXT_WEIGHT = 2;

// Palavras de frustração com peso maior (peso 2 por padrão aqui)
const STRONG_FRUSTRATION_WEIGHTS: Record<string, number> = {
  absurdo: 2,
  ridiculo: 2,
  "ridículo": 2,
  processo: 2,
  inaceitavel: 2,
  "inaceitável": 2,
  pessimo: 2,
  "péssimo": 2,
  horrivel: 2,
  "horrível": 2,
  enganacao: 2,
  "enganação": 2,
  procon: 2,
  advogado: 2,
  processar: 2,
  cancelar: 2,
};

const CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutos

function cacheKey(userId: number | string, sessionName: string) {
  return `USER${userId}_${sessionName}`;
}

function runtimeKey(userId: number | string, sessionName: string, chatId: string) {
  return `${cacheKey(userId, sessionName)}::${chatId}`;
}

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function isInSilenceWindow(userId: number): Promise<boolean> {
  const now = Date.now();
  const cached = silenceCache.get(userId);
  if (cached && now - cached.fetchedAt < 5 * 60 * 1000) {
    return cached.value;
  }

  try {
    const value = await isInSilenceWindowUtil(userId);
    silenceCache.set(userId, { value, fetchedAt: now });
    return value;
  } catch (err) {
    console.warn("Falha ao checar horÃ¡rio de silÃªncio (fallback):", err);
    return false;
  }
}

function parseJsonArray(value: any, fallback: string[]): string[] {
  if (!value) return fallback;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => String(v || "").trim())
        .filter((v) => v.length > 0);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function applySensitivity(base: number, sensitivity: FallbackSensitivity) {
  if (!Number.isFinite(base) || base <= 0) return 1;
  if (sensitivity === "high") return Math.max(1, base - 1);
  if (sensitivity === "low") return base + 1;
  return base;
}

function buildEffectiveSettings(
  base: FallbackSettings,
  source: "db" | "default"
): EffectiveFallbackSettings {
  const sensitivity = base.fallbackSensitivity || DEFAULT_FALLBACK_SETTINGS.fallbackSensitivity;

  const limits = {
    repetition: applySensitivity(base.maxRepetitions || DEFAULT_FALLBACK_SETTINGS.maxRepetitions, sensitivity),
    frustration: applySensitivity(base.maxFrustration || DEFAULT_FALLBACK_SETTINGS.maxFrustration, sensitivity),
    iaFailures: applySensitivity(base.maxIaFailures || DEFAULT_FALLBACK_SETTINGS.maxIaFailures, sensitivity),
  };

  const humanMinutes =
    base.humanModeDuration === null
      ? null
      : Number.isFinite(base.humanModeDuration)
        ? Number(base.humanModeDuration)
        : DEFAULT_FALLBACK_SETTINGS.humanModeDuration;

  const humanDurationMs =
    humanMinutes === null || humanMinutes === 0
      ? null
      : Math.max(1, humanMinutes) * 60 * 1000;

  const cooldownMinutes =
    base.fallbackCooldownMinutes === null || base.fallbackCooldownMinutes === undefined
      ? DEFAULT_FALLBACK_SETTINGS.fallbackCooldownMinutes
      : Number(base.fallbackCooldownMinutes);

  const cooldownMs =
    cooldownMinutes === null || cooldownMinutes === 0
      ? null
      : Math.max(1, cooldownMinutes) * 60 * 1000;

  return {
    ...base,
    limits,
    humanDurationMs,
    cooldownMs,
    source,
  };
}

export async function loadFallbackSettings(
  userId: number,
  sessionName: string
): Promise<EffectiveFallbackSettings> {
  const key = cacheKey(userId, sessionName);
  const cached = fallbackSettingsCache.get(key);
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const db = getDB();

  const row = await db.get<any>(
    `
    SELECT *
    FROM fallback_settings
    WHERE user_id = ? AND session_name = ?
    LIMIT 1
    `,
    [userId, sessionName]
  );

  if (!row) {
    const effective = buildEffectiveSettings({ ...DEFAULT_FALLBACK_SETTINGS }, "default");
    fallbackSettingsCache.set(key, { value: effective, storedAt: Date.now() });
    return effective;
  }

  const settings: FallbackSettings = {
    enableFallback: row.enable_fallback !== 0,
    fallbackMessage: row.fallback_message || DEFAULT_FALLBACK_SETTINGS.fallbackMessage,
    fallbackSensitivity: (row.fallback_sensitivity as FallbackSensitivity) || DEFAULT_FALLBACK_SETTINGS.fallbackSensitivity,
    maxRepetitions: row.max_repetitions ?? DEFAULT_FALLBACK_SETTINGS.maxRepetitions,
    maxFrustration: row.max_frustration ?? DEFAULT_FALLBACK_SETTINGS.maxFrustration,
    maxIaFailures: row.max_ia_failures ?? DEFAULT_FALLBACK_SETTINGS.maxIaFailures,
    triggerWords: parseJsonArray(row.trigger_words, DEFAULT_FALLBACK_SETTINGS.triggerWords),
    frustrationWords: parseJsonArray(row.frustration_words, DEFAULT_FALLBACK_SETTINGS.frustrationWords),
    aiUncertaintyPhrases: parseJsonArray(row.ai_uncertainty_phrases, DEFAULT_FALLBACK_SETTINGS.aiUncertaintyPhrases),
    aiTransferPhrases: parseJsonArray(row.ai_transfer_phrases, DEFAULT_FALLBACK_SETTINGS.aiTransferPhrases),
    humanModeDuration:
      row.human_mode_duration === null || row.human_mode_duration === undefined
        ? DEFAULT_FALLBACK_SETTINGS.humanModeDuration
        : Number(row.human_mode_duration),
    notifyPanel: row.notify_panel ?? DEFAULT_FALLBACK_SETTINGS.notifyPanel,
    notifyWebhook: row.notify_webhook ?? DEFAULT_FALLBACK_SETTINGS.notifyWebhook,
    webhookUrl: row.webhook_url || DEFAULT_FALLBACK_SETTINGS.webhookUrl,
    alertPhone: row.alert_phone || DEFAULT_FALLBACK_SETTINGS.alertPhone,
    alertMessage: row.alert_message || DEFAULT_FALLBACK_SETTINGS.alertMessage,
    fallbackCooldownMinutes:
      row.fallback_cooldown_minutes === null || row.fallback_cooldown_minutes === undefined
        ? DEFAULT_FALLBACK_SETTINGS.fallbackCooldownMinutes
        : Number(row.fallback_cooldown_minutes),
  };

  const effective = buildEffectiveSettings(settings, "db");
  fallbackSettingsCache.set(key, { value: effective, storedAt: Date.now() });
  return effective;
}

export async function saveFallbackSettings(
  userId: number,
  sessionName: string,
  payload: FallbackSettings
): Promise<EffectiveFallbackSettings> {
  const db = getDB();

  await db.run(
    `
    INSERT INTO fallback_settings (
      user_id,
      session_name,
      enable_fallback,
      fallback_message,
      fallback_sensitivity,
      max_repetitions,
      max_frustration,
      max_ia_failures,
      trigger_words,
      frustration_words,
      ai_uncertainty_phrases,
      ai_transfer_phrases,
      human_mode_duration,
      notify_panel,
      notify_webhook,
      webhook_url,
      alert_phone,
      alert_message,
      fallback_cooldown_minutes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      enable_fallback = VALUES(enable_fallback),
      fallback_message = VALUES(fallback_message),
      fallback_sensitivity = VALUES(fallback_sensitivity),
      max_repetitions = VALUES(max_repetitions),
      max_frustration = VALUES(max_frustration),
      max_ia_failures = VALUES(max_ia_failures),
      trigger_words = VALUES(trigger_words),
      frustration_words = VALUES(frustration_words),
      ai_uncertainty_phrases = VALUES(ai_uncertainty_phrases),
      ai_transfer_phrases = VALUES(ai_transfer_phrases),
      human_mode_duration = VALUES(human_mode_duration),
      notify_panel = VALUES(notify_panel),
      notify_webhook = VALUES(notify_webhook),
      webhook_url = VALUES(webhook_url),
      alert_phone = VALUES(alert_phone),
      alert_message = VALUES(alert_message),
      fallback_cooldown_minutes = VALUES(fallback_cooldown_minutes)
    `,
    [
      userId,
      sessionName,
      payload.enableFallback ? 1 : 0,
      payload.fallbackMessage,
      payload.fallbackSensitivity,
      payload.maxRepetitions,
      payload.maxFrustration,
      payload.maxIaFailures,
      JSON.stringify(payload.triggerWords || []),
      JSON.stringify(payload.frustrationWords || []),
      JSON.stringify(payload.aiUncertaintyPhrases || []),
      JSON.stringify(payload.aiTransferPhrases || []),
      payload.humanModeDuration === null ? null : payload.humanModeDuration,
      payload.notifyPanel ? 1 : 0,
      payload.notifyWebhook ? 1 : 0,
      payload.webhookUrl,
      payload.alertPhone || null,
      payload.alertMessage || DEFAULT_FALLBACK_SETTINGS.alertMessage,
      payload.fallbackCooldownMinutes ?? DEFAULT_FALLBACK_SETTINGS.fallbackCooldownMinutes,
    ]
  );

  const effective = buildEffectiveSettings(payload, "db");
  fallbackSettingsCache.set(cacheKey(userId, sessionName), { value: effective, storedAt: Date.now() });
  return effective;
}

export async function primeFallbackCache(userId: number, sessionName: string) {
  try {
    await loadFallbackSettings(userId, sessionName);
  } catch (err) {
    console.error("Erro ao carregar fallback_settings no cache:", err);
  }
}

function getRuntimeState(key: string): RuntimeState {
  const now = Date.now();
  const existing = runtimeByChat.get(key);

  if (existing && now - existing.lastUpdated < 6 * 60 * 60 * 1000) {
    existing.lastUpdated = now;
    return existing;
  }

  const fresh: RuntimeState = {
    lastMessage: null,
    repetitionCount: 0,
    frustrationScore: 0,
    iaFailureCount: 0,
    lastFrustration: null,
    lastUpdated: now,
  };

  runtimeByChat.set(key, fresh);
  return fresh;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return dp[a.length][b.length];
}

function fuzzyMatchText(text: string, candidate: string): boolean {
  const normText = normalize(text);
  const normCand = normalize(candidate);
  if (!normCand) return false;

  // 1) match direto por substring
  if (normText.includes(normCand)) return true;

  // 2) fuzzy por palavras (corrige typos simples)
  const words = normText.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const dist = levenshtein(w, normCand);
    const maxLen = Math.max(w.length, normCand.length);
    const ratio = maxLen === 0 ? 1 : dist / maxLen;

    // tolerância: até 1 erro para palavras curtas, até 2 para médias,
    // ou distância relativa até 30%
    if (
      (maxLen <= 4 && dist <= 1) ||
      (maxLen <= 8 && dist <= 2) ||
      ratio <= 0.3
    ) {
      return true;
    }
  }

  return false;
}

function findMatch(text: string, options: string[]): string | null {
  for (const raw of options) {
    const candidate = String(raw || "");
    if (!candidate.trim()) continue;
    if (fuzzyMatchText(text, candidate)) return raw;
  }
  return null;
}

function frustrationWeight(term: string): number {
  const norm = normalize(term);
  return STRONG_FRUSTRATION_WEIGHTS[norm] ?? 1;
}

export async function checkFallbackTriggers(params: {
  userId: number;
  sessionName: string;
  chatId: string;
  event: "user_message" | "ai_response" | "ai_error";
  message?: string;
  aiResponse?: string;
  mediaType?: "audio" | "document" | "image" | "video";
  mediaSeconds?: number | null;
  hasText?: boolean;
}): Promise<FallbackDecision> {
  const config = await loadFallbackSettings(params.userId, params.sessionName);

  if (!config.enableFallback) {
    return { shouldFallback: false, config };
  }

  // janela de silêncio (reuse do horário de silêncio da IA)
  if (await isInSilenceWindow(params.userId)) {
    return { shouldFallback: false, reason: "silence_window", config };
  }

  const state = getRuntimeState(runtimeKey(params.userId, params.sessionName, params.chatId));
  const cooldownKey = runtimeKey(params.userId, params.sessionName, params.chatId);
  const lastFb = lastFallbackAt.get(cooldownKey);
  if (config.cooldownMs && lastFb && Date.now() - lastFb < config.cooldownMs) {
    return { shouldFallback: false, reason: "cooldown", config };
  }

  if (params.event === "user_message") {
    const text = params.message || "";
    const isLongAudio =
      params.mediaType === "audio" &&
      params.mediaSeconds !== null &&
      params.mediaSeconds !== undefined &&
      Number(params.mediaSeconds) >= LONG_AUDIO_SECONDS;

    const isDocumentNoText = params.mediaType === "document" && params.hasText === false;

    if (isLongAudio) {
      state.frustrationScore += DOCUMENT_NO_TEXT_WEIGHT; // peso 2 para áudio longo
      state.lastFrustration = "[audio_longo]";
    }

    if (isDocumentNoText) {
      state.frustrationScore += DOCUMENT_NO_TEXT_WEIGHT; // peso 2 para doc sem contexto
      state.lastFrustration = "[documento_sem_contexto]";
    }
    const directRequest = findMatch(text, config.triggerWords);
    if (directRequest) {
      return {
        shouldFallback: true,
        reason: "user_request",
        matchedPhrase: directRequest,
        config,
      };
    }

    const matchFrustration = findMatch(text, config.frustrationWords);
    if (matchFrustration) {
      state.frustrationScore += frustrationWeight(matchFrustration);
      state.lastFrustration = matchFrustration;
    } else {
      state.frustrationScore = Math.max(0, state.frustrationScore - 1);
      state.lastFrustration = null;
    }

    const normalized = normalize(text);
    if (state.lastMessage && state.lastMessage === normalized) {
      state.repetitionCount += 1;
    } else {
      state.lastMessage = normalized;
      state.repetitionCount = 1;
    }

    if (state.repetitionCount >= config.limits.repetition) {
      return {
        shouldFallback: true,
        reason: "repetition_limit",
        matchedPhrase: state.lastMessage || undefined,
        config,
      };
    }

    if (state.frustrationScore >= config.limits.frustration) {
      return {
        shouldFallback: true,
        reason: "frustration_limit",
        matchedPhrase: state.lastFrustration || undefined,
        config,
      };
    }

    return { shouldFallback: false, config };
  }

  if (params.event === "ai_error") {
    state.iaFailureCount += 1;
    if (state.iaFailureCount >= config.limits.iaFailures) {
      return {
        shouldFallback: true,
        reason: "ai_failure",
        config,
      };
    }
    return { shouldFallback: false, config };
  }

  if (params.event === "ai_response" && params.aiResponse) {
    const response = params.aiResponse;

    const transfer = findMatch(response, config.aiTransferPhrases);
    if (transfer) {
      return {
        shouldFallback: true,
        reason: "ai_transfer",
        matchedPhrase: transfer,
        config,
      };
    }

    const uncertainty = findMatch(response, config.aiUncertaintyPhrases);
    if (uncertainty) {
      state.iaFailureCount += 1;
      if (state.iaFailureCount >= config.limits.iaFailures) {
        return {
          shouldFallback: true,
          reason: "ai_uncertainty",
          matchedPhrase: uncertainty,
          config,
        };
      }
    } else {
      state.iaFailureCount = Math.max(0, state.iaFailureCount - 1);
    }
  }

  return { shouldFallback: false, config };
}

export function clearFallbackRuntime(userId: number, sessionName: string, chatId: string) {
  runtimeByChat.delete(runtimeKey(userId, sessionName, chatId));
}

export function resetFallbackCache(userId: number, sessionName: string) {
  fallbackSettingsCache.delete(cacheKey(userId, sessionName));
}

export function markFallbackTimestamp(userId: number, sessionName: string, chatId: string) {
  lastFallbackAt.set(runtimeKey(userId, sessionName, chatId), Date.now());
}
