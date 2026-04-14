import { getDB } from "../database";
import { PLAN_NAMES, PLANS, type PlanConfig, type PlanIaLimit, type PlanName } from "../config/plans";

type PlanConfigRow = {
  plan_key: PlanName;
  display_name: string | null;
  badge_label: string | null;
  price: number | string | null;
  max_sessions: number | string | null;
  max_ia_messages: string | number | null;
  max_broadcast_numbers: number | string | null;
  feature_list: string | null;
  highlight: number | boolean | null;
  updated_at: number | string | null;
};

type PlanConfigInput = {
  plan: PlanName;
  displayName?: string | null;
  badgeLabel?: string | null;
  price?: number | string | null;
  maxSessions?: number | string | null;
  maxIaMessages?: number | string | null;
  maxBroadcastNumbers?: number | string | null;
  featureList?: string[] | string | null;
  highlight?: boolean | number | string | null;
};

function clampInteger(value: unknown, fallback: number, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

function normalizePrice(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Number(parsed.toFixed(2));
}

function normalizeIaLimit(value: unknown, fallback: PlanIaLimit): PlanIaLimit {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "unlimited" || text === "ilimitado" || text === "∞") {
    return "unlimited";
  }

  const numericFallback = fallback === "unlimited" ? 0 : fallback;
  return clampInteger(value, numericFallback, 0);
}

function normalizeFeatureList(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 8);
    return items.length ? items : fallback;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return normalizeFeatureList(parsed, fallback);
      }
    } catch {
      const items = value
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (items.length) return items;
    }
  }

  return fallback;
}

function normalizeBadgeLabel(value: unknown, fallback: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.slice(0, 60);
}

function normalizeDisplayName(value: unknown, fallback: string) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 60) : fallback;
}

function normalizeHighlight(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes", "sim"].includes(text)) return true;
  if (["0", "false", "off", "no", "nao", "não"].includes(text)) return false;
  return fallback;
}

function normalizePlanConfig(
  plan: PlanName,
  input?: Partial<PlanConfigInput & PlanConfigRow> | null
): PlanConfig {
  const fallback = PLANS[plan];

  return {
    ...fallback,
    name: plan,
    displayName: normalizeDisplayName(
      input?.displayName ?? input?.display_name,
      fallback.displayName
    ),
    badgeLabel: normalizeBadgeLabel(
      input?.badgeLabel ?? input?.badge_label,
      fallback.badgeLabel
    ),
    price: normalizePrice(input?.price, fallback.price),
    maxSessions: clampInteger(input?.maxSessions ?? input?.max_sessions, fallback.maxSessions, 1),
    maxIaMessages: normalizeIaLimit(
      input?.maxIaMessages ?? input?.max_ia_messages,
      fallback.maxIaMessages
    ),
    maxBroadcastNumbers: clampInteger(
      input?.maxBroadcastNumbers ?? input?.max_broadcast_numbers,
      fallback.maxBroadcastNumbers,
      1
    ),
    featureList: normalizeFeatureList(
      input?.featureList ?? input?.feature_list,
      fallback.featureList
    ),
    highlight: normalizeHighlight(input?.highlight, fallback.highlight),
    updatedAt: clampInteger(input?.updated_at, fallback.updatedAt, 0),
  };
}

export function isPlanName(value: string): value is PlanName {
  return PLAN_NAMES.includes(value as PlanName);
}

export function serializePlanIaLimit(value: PlanIaLimit) {
  return value === "unlimited" ? "unlimited" : String(value);
}

export async function listPlanConfigs(): Promise<PlanConfig[]> {
  const db = getDB();
  const rows = await db.all<PlanConfigRow>(
    `SELECT
      plan_key,
      display_name,
      badge_label,
      price,
      max_sessions,
      max_ia_messages,
      max_broadcast_numbers,
      feature_list,
      highlight,
      updated_at
     FROM plan_configs`
  );

  const byKey = new Map<PlanName, PlanConfigRow>();
  rows.forEach((row) => {
    if (isPlanName(String(row.plan_key || "").trim())) {
      byKey.set(row.plan_key, row);
    }
  });

  return PLAN_NAMES.map((plan) => normalizePlanConfig(plan, byKey.get(plan)));
}

export async function getPlanConfig(plan: string | null | undefined): Promise<PlanConfig | null> {
  const normalized = String(plan || "").trim().toLowerCase();
  if (!isPlanName(normalized)) return null;

  const plans = await listPlanConfigs();
  return plans.find((item) => item.name === normalized) || null;
}

export async function savePlanConfig(input: PlanConfigInput): Promise<PlanConfig> {
  const db = getDB();
  const normalized = normalizePlanConfig(input.plan, input as any);
  const updatedAt = Date.now();

  await db.run(
    `INSERT INTO plan_configs (
      plan_key,
      display_name,
      badge_label,
      price,
      max_sessions,
      max_ia_messages,
      max_broadcast_numbers,
      feature_list,
      highlight,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      badge_label = VALUES(badge_label),
      price = VALUES(price),
      max_sessions = VALUES(max_sessions),
      max_ia_messages = VALUES(max_ia_messages),
      max_broadcast_numbers = VALUES(max_broadcast_numbers),
      feature_list = VALUES(feature_list),
      highlight = VALUES(highlight),
      updated_at = VALUES(updated_at)`,
    [
      normalized.name,
      normalized.displayName,
      normalized.badgeLabel,
      normalized.price,
      normalized.maxSessions,
      serializePlanIaLimit(normalized.maxIaMessages),
      normalized.maxBroadcastNumbers,
      JSON.stringify(normalized.featureList),
      normalized.highlight ? 1 : 0,
      updatedAt,
    ]
  );

  return {
    ...normalized,
    updatedAt,
  };
}
