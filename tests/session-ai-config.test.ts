import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptFromAiConfiguration,
  createEmptyAiConfiguration,
  hasAiConfigurationContent,
  hasUsableAiConfiguration,
  normalizeAiConfiguration,
  parseAiConfiguration,
  resolveAiPrompt,
} from "../src/services/aiConfiguration";
import { createSessionChatKey } from "../src/utils/sessionChatKey";
import { isSafeSessionName } from "../src/utils/sessionName";

test("AI prompt resolver prefers an explicit session configuration", () => {
  const accountConfig = normalizeAiConfiguration({ assistantName: "Conta" });
  const sessionConfig = normalizeAiConfiguration({ assistantName: "Vendas" });

  const prompt = resolveAiPrompt({
    sessionConfig: JSON.stringify(sessionConfig),
    accountConfig: JSON.stringify(accountConfig),
    legacyPrompt: "prompt global legado",
  });

  assert.match(prompt, /Vendas/);
  assert.doesNotMatch(prompt, /Conta/);
});

test("AI prompt resolver gives a linked named agent precedence for its session", () => {
  const agentConfig = normalizeAiConfiguration({ assistantName: "Agente de Vendas" });
  const prompt = resolveAiPrompt({
    agentConfig: JSON.stringify(agentConfig),
    sessionConfig: JSON.stringify(normalizeAiConfiguration({ assistantName: "Override antigo" })),
    accountConfig: JSON.stringify(normalizeAiConfiguration({ assistantName: "Conta" })),
    legacyPrompt: "prompt global legado",
  });

  assert.match(prompt, /Agente de Vendas/);
  assert.doesNotMatch(prompt, /Override antigo|prompt global legado|Conta/);
});

test("AI prompt resolver inherits the current global prompt when the session has no override", () => {
  const prompt = resolveAiPrompt({
    sessionConfig: null,
    accountConfig: JSON.stringify(normalizeAiConfiguration({ assistantName: "Conta" })),
    legacyPrompt: "prompt global atualizado",
  });

  assert.equal(prompt, "prompt global atualizado");
});

test("AI prompt resolver falls back to account configuration if the legacy prompt is empty", () => {
  const accountConfig = normalizeAiConfiguration({ assistantName: "Conta" });
  const prompt = resolveAiPrompt({
    sessionConfig: "invalid-json",
    accountConfig: JSON.stringify(accountConfig),
    legacyPrompt: "",
  });

  assert.equal(prompt, buildPromptFromAiConfiguration(accountConfig));
});

test("empty AI config has no executable instructions", () => {
  assert.equal(resolveAiPrompt({ sessionConfig: createEmptyAiConfiguration() }), "");
});

test("missing or malformed AI configuration is treated as empty", () => {
  assert.equal(hasAiConfigurationContent(parseAiConfiguration(null)), false);
  assert.equal(hasAiConfigurationContent(null), false);
  assert.equal(hasAiConfigurationContent(undefined), false);
  assert.equal(hasAiConfigurationContent({ assistantName: null }), false);
});

test("AI automation can be enabled only when a usable account, legacy, or scoped config exists", () => {
  const scopedConfig = JSON.stringify(normalizeAiConfiguration({ assistantName: "Ana" }));

  assert.equal(hasUsableAiConfiguration({}), false);
  assert.equal(hasUsableAiConfiguration({ accountConfig: "{invalid}" }), false);
  assert.equal(hasUsableAiConfiguration({ accountConfig: scopedConfig }), true);
  assert.equal(hasUsableAiConfiguration({ scopedConfigs: [null, scopedConfig] }), true);
  assert.equal(hasUsableAiConfiguration({ legacyPrompt: "Instruções antigas para atendimento" }), true);
  assert.equal(hasUsableAiConfiguration({ legacyPrompt: "curto" }), false);
});

test("runtime history keys are isolated by user, session, and chat", () => {
  const first = createSessionChatKey(7, "vendas", "5511999999999@c.us");
  const second = createSessionChatKey(7, "suporte", "5511999999999@c.us");
  const otherUser = createSessionChatKey(8, "vendas", "5511999999999@c.us");

  assert.notEqual(first, second);
  assert.notEqual(first, otherUser);
  assert.equal(first, createSessionChatKey("7", "vendas", "5511999999999@c.us"));
});

test("session names reject path separators and control characters", () => {
  assert.equal(isSafeSessionName("vendas 2"), true);
  assert.equal(isSafeSessionName("../outside"), false);
  assert.equal(isSafeSessionName("session\\name"), false);
  assert.equal(isSafeSessionName("name?with-query"), false);
  assert.equal(isSafeSessionName("bad\nname"), false);
});
