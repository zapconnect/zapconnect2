import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeAiConfigurationDraft,
  normalizeAiConfigAssistantProviderError,
  normalizeAiAgentSimulationMessages,
  parseAiConfigAssistantResponse,
} from "../src/services/aiConfigAssistant";
import { createEmptyAiConfiguration } from "../src/services/aiConfiguration";

test("ajuste do assistente preserva os campos que não foram alterados", () => {
  const current = {
    assistantName: "Ana",
    companyName: "Clínica Horizonte",
    personalityTone: "Formal",
    mainObjective: "Agendar avaliações",
  };
  const result = mergeAiConfigurationDraft(
    current,
    { personalityTone: "Acolhedora e informal" },
    "adjust"
  );

  assert.equal(result.assistantName, "Ana");
  assert.equal(result.companyName, "Clínica Horizonte");
  assert.equal(result.personalityTone, "Acolhedora e informal");
  assert.equal(result.mainObjective, "Agendar avaliações");
});

test("criação não herda dados antigos da configuração", () => {
  const result = mergeAiConfigurationDraft(
    { assistantName: "Antiga" },
    { companyName: "Nova empresa" },
    "create"
  );

  assert.equal(result.assistantName, "");
  assert.equal(result.companyName, "Nova empresa");
});

test("parser aceita JSON em bloco de código e normaliza os campos permitidos", () => {
  const result = parseAiConfigAssistantResponse(
    '```json\n{"assistantName":"Lia","companyName":"Loja","ignore":"x"}\n```',
    createEmptyAiConfiguration(),
    "create"
  );

  assert.equal(result.assistantName, "Lia");
  assert.equal(result.companyName, "Loja");
  assert.equal("ignore" in result, false);
});

test("parser rejeita respostas vazias ou inválidas", () => {
  assert.throws(
    () => parseAiConfigAssistantResponse("isso não é JSON", {}, "create"),
    /AI_CONFIG_ASSISTANT_INVALID_RESPONSE/
  );
  assert.throws(
    () => parseAiConfigAssistantResponse("{}", {}, "create"),
    /AI_CONFIG_ASSISTANT_EMPTY_RESPONSE/
  );
});

test("provedor reporta falhas de rede sem propagar detalhes da requisição", () => {
  const error = normalizeAiConfigAssistantProviderError(
    new Error("[GoogleGenerativeAI Error] fetch failed")
  );
  assert.equal(error.message, "AI_CONFIG_ASSISTANT_NETWORK_ERROR");

  const credentialError = normalizeAiConfigAssistantProviderError(
    new Error("API key not valid: AIza-this-must-not-leak")
  );
  assert.equal(credentialError.message, "AI_CONFIG_ASSISTANT_INVALID_CREDENTIALS");
  assert.doesNotMatch(credentialError.message, /AIza/);

  const accessDeniedError = normalizeAiConfigAssistantProviderError({
    status: 403,
    message: "PERMISSION_DENIED: Generative Language API is disabled",
  });
  assert.equal(accessDeniedError.message, "AI_CONFIG_ASSISTANT_API_ACCESS_DENIED");

  const explicitInvalidKeyWithForbiddenStatus = normalizeAiConfigAssistantProviderError({
    status: 403,
    message: "API key not valid: AIza-this-must-not-leak",
  });
  assert.equal(explicitInvalidKeyWithForbiddenStatus.message, "AI_CONFIG_ASSISTANT_INVALID_CREDENTIALS");
  assert.doesNotMatch(explicitInvalidKeyWithForbiddenStatus.message, /AIza/);

  const unauthorizedError = normalizeAiConfigAssistantProviderError({ status: 401, message: "Unauthorized" });
  assert.equal(unauthorizedError.message, "AI_CONFIG_ASSISTANT_INVALID_CREDENTIALS");
});

test("simulador mantém só mensagens de usuário/assistente e limita contexto", () => {
  const messages = normalizeAiAgentSimulationMessages([
    { role: "system", content: "ignorar" },
    { role: "user", content: "  Oi  " },
  ]);
  assert.deepEqual(messages, [{ role: "user", content: "Oi" }]);

  assert.throws(
    () => normalizeAiAgentSimulationMessages([{ role: "assistant", content: "Olá" }]),
    /AI_AGENT_SIMULATION_INVALID_MESSAGES/
  );
});
