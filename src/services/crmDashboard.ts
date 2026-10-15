export type CrmDashboardStageRow = {
  stage?: unknown;
  contacts?: unknown;
  dealValue?: unknown;
};

export type CrmDashboardMetrics = {
  totalContacts?: unknown;
  activeOpportunities?: unknown;
  activePipelineValue?: unknown;
  wonCount?: unknown;
  wonValue?: unknown;
  overdueFollowUps?: unknown;
  upcomingFollowUps?: unknown;
};

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function toMoney(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function canonicalStage(value: unknown): string {
  const label = String(value ?? "").trim() || "Novo";
  const key = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");

  const knownStages: Record<string, string> = {
    novo: "Novo",
    qualificando: "Qualificando",
    negociacao: "Negociação",
    fechado: "Fechado",
    perdido: "Perdido",
  };

  return knownStages[key] || label;
}

const STAGE_ORDER = ["Novo", "Qualificando", "Negociação", "Fechado", "Perdido"];

export function buildCrmDashboardSummary(
  metrics: CrmDashboardMetrics,
  stageRows: CrmDashboardStageRow[]
) {
  const stages = stageRows
    .map((row) => ({
      stage: canonicalStage(row.stage),
      contacts: toCount(row.contacts),
      dealValue: toMoney(row.dealValue),
    }))
    .sort((left, right) => {
      const leftOrder = STAGE_ORDER.indexOf(left.stage);
      const rightOrder = STAGE_ORDER.indexOf(right.stage);
      if (leftOrder !== -1 || rightOrder !== -1) {
        return (leftOrder === -1 ? STAGE_ORDER.length : leftOrder) -
          (rightOrder === -1 ? STAGE_ORDER.length : rightOrder);
      }
      return left.stage.localeCompare(right.stage, "pt-BR");
    });

  return {
    totalContacts: toCount(metrics.totalContacts),
    activeOpportunities: toCount(metrics.activeOpportunities),
    activePipelineValue: toMoney(metrics.activePipelineValue),
    wonCount: toCount(metrics.wonCount),
    wonValue: toMoney(metrics.wonValue),
    overdueFollowUps: toCount(metrics.overdueFollowUps),
    upcomingFollowUps: toCount(metrics.upcomingFollowUps),
    stageBreakdown: stages,
  };
}
