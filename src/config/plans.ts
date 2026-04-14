export const PLAN_NAMES = ["free", "starter", "pro"] as const;

export type PlanName = typeof PLAN_NAMES[number];

export type PlanIaLimit = number | "unlimited";

export type PlanConfig = {
  name: PlanName;
  displayName: string;
  badgeLabel: string | null;
  price: number;
  maxSessions: number;
  maxIaMessages: PlanIaLimit;
  maxBroadcastNumbers: number;
  featureList: string[];
  highlight: boolean;
  mpPlanId: string | null;
  updatedAt: number;
};

export const PLANS: Record<PlanName, PlanConfig> = {
  free: {
    name: "free",
    displayName: "Free",
    badgeLabel: "Free",
    price: 0,
    maxSessions: 1,
    maxIaMessages: 500,
    maxBroadcastNumbers: 50,
    featureList: [
      "1 sessão de WhatsApp",
      "500 mensagens IA",
      "7 dias grátis",
    ],
    highlight: false,
    mpPlanId: null,
    updatedAt: 0,
  },

  starter: {
    name: "starter",
    displayName: "Starter",
    badgeLabel: "Popular",
    price: 97,
    maxSessions: 1,
    maxIaMessages: 500,
    maxBroadcastNumbers: 50,
    featureList: [
      "1 sessão de WhatsApp",
      "500 mensagens IA / mês",
      "Suporte completo",
    ],
    highlight: true,
    mpPlanId: "starter",
    updatedAt: 0,
  },

  pro: {
    name: "pro",
    displayName: "Pro",
    badgeLabel: "Pro",
    price: 197,
    maxSessions: 3,
    maxIaMessages: "unlimited",
    maxBroadcastNumbers: 200,
    featureList: [
      "Até 3 sessões",
      "IA ilimitada",
      "Recursos avançados",
    ],
    highlight: false,
    mpPlanId: "pro",
    updatedAt: 0,
  },
};
