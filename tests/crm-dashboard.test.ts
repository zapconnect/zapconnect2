import assert from "node:assert/strict";
import test from "node:test";
import { buildCrmDashboardSummary } from "../src/services/crmDashboard";

test("CRM dashboard normalizes database numeric strings and orders known stages", () => {
  const summary = buildCrmDashboardSummary(
    {
      totalContacts: "6",
      activeOpportunities: "4",
      activePipelineValue: "1280.5",
      wonCount: "1",
      wonValue: "450.999",
      overdueFollowUps: "2",
      upcomingFollowUps: "1",
    },
    [
      { stage: "Fechado", contacts: "1", dealValue: "450.99" },
      { stage: "Negociacao", contacts: "2", dealValue: "800" },
      { stage: "Novo", contacts: 3, dealValue: null },
    ]
  );

  assert.deepEqual(summary, {
    totalContacts: 6,
    activeOpportunities: 4,
    activePipelineValue: 1280.5,
    wonCount: 1,
    wonValue: 451,
    overdueFollowUps: 2,
    upcomingFollowUps: 1,
    stageBreakdown: [
      { stage: "Novo", contacts: 3, dealValue: 0 },
      { stage: "Negociação", contacts: 2, dealValue: 800 },
      { stage: "Fechado", contacts: 1, dealValue: 450.99 },
    ],
  });
});

test("CRM dashboard safely represents empty or malformed aggregates", () => {
  const summary = buildCrmDashboardSummary(
    {
      totalContacts: undefined,
      activePipelineValue: "not-a-number",
      overdueFollowUps: -5,
    },
    [{ stage: "", contacts: "invalid", dealValue: "NaN" }]
  );

  assert.equal(summary.totalContacts, 0);
  assert.equal(summary.activePipelineValue, 0);
  assert.equal(summary.overdueFollowUps, 0);
  assert.deepEqual(summary.stageBreakdown, [
    { stage: "Novo", contacts: 0, dealValue: 0 },
  ]);
});
