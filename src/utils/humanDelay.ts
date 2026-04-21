const HOUR_WINDOW_MS = 60 * 60 * 1000;
const MINUTE_WINDOW_MS = 60 * 1000;
const TYPING_JITTER_FACTOR = 0.25;
const TYPING_THINKING_PROBABILITY = 0.2;

const TYPING_CHARS_PER_SECOND = Number(
  process.env.WA_TYPING_CHARS_PER_SECOND || 8
);
const MIN_TYPING_DELAY_MS = Number(
  process.env.WA_MIN_TYPING_DELAY_MS || 1500
);
const MAX_TYPING_DELAY_MS = Number(
  process.env.WA_MAX_TYPING_DELAY_MS || 18000
);
const MESSAGE_CONTINUATION_MIN_DELAY_MS = Number(
  process.env.WA_MESSAGE_CONTINUATION_MIN_DELAY_MS || 800
);
const MESSAGE_CONTINUATION_MAX_DELAY_MS = Number(
  process.env.WA_MESSAGE_CONTINUATION_MAX_DELAY_MS || 2000
);
const POST_TYPING_MIN_DELAY_MS = Number(
  process.env.WA_POST_TYPING_MIN_DELAY_MS || 200
);
const POST_TYPING_MAX_DELAY_MS = Number(
  process.env.WA_POST_TYPING_MAX_DELAY_MS || 600
);
const THINKING_PAUSE_MIN_DELAY_MS = Number(
  process.env.WA_THINKING_PAUSE_MIN_DELAY_MS || 2000
);
const THINKING_PAUSE_MAX_DELAY_MS = Number(
  process.env.WA_THINKING_PAUSE_MAX_DELAY_MS || 5000
);

export const MAX_SESSION_MESSAGES_PER_HOUR = Number(
  process.env.WA_MAX_SESSION_MESSAGES_PER_HOUR || 200
);
export const MAX_SESSION_MESSAGES_PER_MINUTE = Number(
  process.env.WA_MAX_SESSION_MESSAGES_PER_MINUTE || 10
);

type SessionSendWindow = {
  hourCount: number;
  hourWindowStart: number;
  minuteCount: number;
  minuteWindowStart: number;
};

const sessionMessageCount = new Map<string, SessionSendWindow>();

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function normalizeSessionName(sessionName?: string | null): string {
  return String(sessionName || "").trim() || "shared-session";
}

function normalizeMessageForTyping(message: string): string {
  return String(message || "").replace(/\s+/g, " ").trim();
}

function refreshWindowState(sessionName: string, now = Date.now()): SessionSendWindow {
  const normalized = normalizeSessionName(sessionName);
  const current =
    sessionMessageCount.get(normalized) || {
      hourCount: 0,
      hourWindowStart: now,
      minuteCount: 0,
      minuteWindowStart: now,
    };

  if (now - current.hourWindowStart >= HOUR_WINDOW_MS) {
    current.hourCount = 0;
    current.hourWindowStart = now;
  }

  if (now - current.minuteWindowStart >= MINUTE_WINDOW_MS) {
    current.minuteCount = 0;
    current.minuteWindowStart = now;
  }

  sessionMessageCount.set(normalized, current);
  return current;
}

function calculateHumanDelay(projectedState: SessionSendWindow, now: number): number {
  const volumeFactor = Math.min(4, 1 + projectedState.hourCount / 50);
  const triangularJitter = (Math.random() + Math.random()) / 2;
  const baseDelayMs = (3000 + triangularJitter * 5000) * volumeFactor;

  const pauseRoll = Math.random();
  let pauseExtraMs = 0;

  if (pauseRoll < 0.08) {
    pauseExtraMs = 10000 + Math.random() * 20000;
  } else if (pauseRoll < 0.23) {
    pauseExtraMs = 3000 + Math.random() * 5000;
  }

  let minutePressureMs = 0;
  const softMinuteThreshold = Math.max(1, MAX_SESSION_MESSAGES_PER_MINUTE - 2);
  if (projectedState.minuteCount >= softMinuteThreshold) {
    const pressureLevel = projectedState.minuteCount - softMinuteThreshold + 1;
    minutePressureMs = pressureLevel * (1500 + Math.random() * 1500);
  }

  let minuteCooldownMs = 0;
  if (projectedState.minuteCount >= MAX_SESSION_MESSAGES_PER_MINUTE) {
    const resetAt = projectedState.minuteWindowStart + MINUTE_WINDOW_MS;
    minuteCooldownMs = Math.max(0, resetAt - now) + 1000 + Math.random() * 2000;
  }

  return Math.ceil(
    Math.max(baseDelayMs + pauseExtraMs + minutePressureMs, minuteCooldownMs)
  );
}

export class SessionRateLimitError extends Error {
  code = "SESSION_RATE_LIMIT_EXCEEDED";
  retryAfterMs: number;
  sessionName: string;

  constructor(sessionName: string, retryAfterMs: number) {
    super(
      `Limite conservador de ${MAX_SESSION_MESSAGES_PER_HOUR} mensagens por hora atingido para a sessao ${sessionName}. Aguarde antes de enviar novamente.`
    );
    this.name = "SessionRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.sessionName = sessionName;
  }
}

export function assertSessionCanSend(sessionName: string, now = Date.now()): void {
  const normalized = normalizeSessionName(sessionName);
  const state = refreshWindowState(normalized, now);

  if (state.hourCount >= MAX_SESSION_MESSAGES_PER_HOUR) {
    const retryAfterMs = Math.max(1000, state.hourWindowStart + HOUR_WINDOW_MS - now);
    throw new SessionRateLimitError(normalized, retryAfterMs);
  }
}

export function getHumanDelay(sessionName: string, now = Date.now()): number {
  const normalized = normalizeSessionName(sessionName);
  const state = refreshWindowState(normalized, now);
  return calculateHumanDelay(
    {
      ...state,
      hourCount: state.hourCount + 1,
      minuteCount: state.minuteCount + 1,
    },
    now
  );
}

export function calculateTypingDelay(
  message: string,
  sessionName?: string | null,
  now = Date.now()
): number {
  const normalizedMessage = normalizeMessageForTyping(message);
  const chars = normalizedMessage.length;
  const baseTypingMs =
    (Math.max(chars, 1) / Math.max(TYPING_CHARS_PER_SECOND, 1)) * 1000;
  const jitterMs =
    baseTypingMs * TYPING_JITTER_FACTOR * (Math.random() * 2 - 1);
  const structurePauseMs = Math.min(
    2500,
    (String(message || "").match(/\n+/g)?.length || 0) * randomBetween(250, 450) +
      (normalizedMessage.match(/[.!?]+/g)?.length || 0) * randomBetween(80, 180)
  );
  const thinkingPauseMs =
    Math.random() < TYPING_THINKING_PROBABILITY
      ? randomBetween(THINKING_PAUSE_MIN_DELAY_MS, THINKING_PAUSE_MAX_DELAY_MS)
      : 0;
  const typedDelayMs =
    baseTypingMs + jitterMs + structurePauseMs + thinkingPauseMs;
  const sessionDelayMs = sessionName ? getHumanDelay(sessionName, now) : 0;

  return Math.ceil(
    Math.max(
      MIN_TYPING_DELAY_MS,
      Math.min(MAX_TYPING_DELAY_MS, Math.max(typedDelayMs, sessionDelayMs))
    )
  );
}

export function getMessageContinuationDelay(
  previousMessage?: string,
  nextMessage?: string
): number {
  const previousLength = normalizeMessageForTyping(previousMessage || "").length;
  const nextLength = normalizeMessageForTyping(nextMessage || "").length;
  const rereadPauseMs = Math.min(1000, previousLength * 3);
  const setupPauseMs = Math.min(600, nextLength * 1.5);

  return Math.ceil(
    randomBetween(
      MESSAGE_CONTINUATION_MIN_DELAY_MS,
      MESSAGE_CONTINUATION_MAX_DELAY_MS
    ) +
      rereadPauseMs * 0.25 +
      setupPauseMs * 0.15
  );
}

export function getPostTypingDelay(): number {
  return Math.ceil(
    randomBetween(POST_TYPING_MIN_DELAY_MS, POST_TYPING_MAX_DELAY_MS)
  );
}

export function recordSessionSend(sessionName: string, now = Date.now()): void {
  const normalized = normalizeSessionName(sessionName);
  const state = refreshWindowState(normalized, now);
  state.hourCount += 1;
  state.minuteCount += 1;
  sessionMessageCount.set(normalized, state);
}
