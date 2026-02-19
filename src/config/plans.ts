export const PLANS = {
  free: {
    name: "free",
    price: 0,
    maxSessions: 1,
    maxIaMessages: 500,
    mpPlanId: null
  },

  starter: {
    name: "starter",
    price: 97, // R$ 97
    maxSessions: 1,
    maxIaMessages: 500,
    mpPlanId: "starter"
  },

  pro: {
    name: "pro",
    price: 197, // R$ 197
    maxSessions: 3,
    maxIaMessages: "unlimited",
    mpPlanId: "pro"
  }
} as const;

export type PlanName = keyof typeof PLANS;