export type RuntimeAiProvider = "GPT" | "GEMINI";
export type ConfiguredAiProvider = RuntimeAiProvider | "GEMINI_FREE";

function normalizeProviderValue(rawValue: string | null | undefined): string {
  return String(rawValue || "").trim().toUpperCase();
}

export function resolveRuntimeAiProvider(
  rawValue: string | null | undefined
): RuntimeAiProvider {
  return normalizeProviderValue(rawValue) === "GPT" ? "GPT" : "GEMINI";
}

export function getConfiguredAiProvider(
  rawValue: string | null | undefined
): ConfiguredAiProvider {
  const normalized = normalizeProviderValue(rawValue);
  if (normalized === "GPT") return "GPT";
  if (normalized === "GEMINI") return "GEMINI";
  return "GEMINI_FREE";
}

export function getAiProviderSummary(rawValue: string | null | undefined) {
  const configured = getConfiguredAiProvider(rawValue);

  if (configured === "GPT") {
    return {
      configured,
      runtime: "GPT" as RuntimeAiProvider,
      label: "OpenAI GPT",
      badge: "Plano pago",
      description: "Atendimento com os modelos da OpenAI configurados no servidor.",
    };
  }

  if (configured === "GEMINI") {
    return {
      configured,
      runtime: "GEMINI" as RuntimeAiProvider,
      label: "Gemini API",
      badge: "Ativo via sistema",
      description: "Atendimento com Gemini configurado no servidor.",
    };
  }

  return {
    configured,
    runtime: "GEMINI" as RuntimeAiProvider,
    label: "Google Gemini",
    badge: "Ativo via sistema",
    description: "Atendimento com Gemini configurado no servidor.",
  };
}
