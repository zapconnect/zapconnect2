import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowInitialAiSetup } from "../src/services/initialAiSetup";

test("initial assistant opens for an account without existing AI setup", () => {
  assert.equal(shouldShowInitialAiSetup({}), true);
  assert.equal(shouldShowInitialAiSetup({ completed: 0, hasAgent: "0", hasSessionConfig: 0 }), true);
});

test("initial assistant stays out of the way when the account already has setup", () => {
  assert.equal(shouldShowInitialAiSetup({ completed: 1 }), false);
  assert.equal(shouldShowInitialAiSetup({ hasAgent: 1 }), false);
  assert.equal(shouldShowInitialAiSetup({ hasSessionConfig: 1 }), false);
  assert.equal(shouldShowInitialAiSetup({ hasAccountConfig: true }), false);
});
