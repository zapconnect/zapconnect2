import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

type OpenAIHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

type AssistantConfig = {
  instructions: string;
  model: string;
};

let openaiClient: OpenAI | null = null;
let assistantConfigPromise: Promise<AssistantConfig> | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_KEY,
    });
  }

  return openaiClient;
}

async function getAssistantConfig(): Promise<AssistantConfig> {
  if (assistantConfigPromise) {
    return assistantConfigPromise;
  }

  assistantConfigPromise = (async () => {
    const openai = getOpenAIClient();
    const fallbackModel = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
    const assistantId = String(process.env.OPENAI_ASSISTANT || "").trim();

    if (!assistantId) {
      return {
        instructions: "",
        model: fallbackModel,
      };
    }

    const assistant = await openai.beta.assistants.retrieve(assistantId);
    return {
      instructions: String(assistant.instructions || "").trim(),
      model: String(assistant.model || fallbackModel).trim() || fallbackModel,
    };
  })().catch((err) => {
    assistantConfigPromise = null;
    throw err;
  });

  return assistantConfigPromise;
}

function normalizeMessage(text: string | null | undefined): string {
  return String(text || "").trim();
}

function buildMessages(params: {
  assistantInstructions: string;
  systemInstruction?: string | null;
  history?: OpenAIHistoryTurn[];
  currentMessage: string;
}) {
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [];

  const combinedSystemInstruction = [
    normalizeMessage(params.assistantInstructions),
    normalizeMessage(params.systemInstruction),
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (combinedSystemInstruction) {
    messages.push({
      role: "system",
      content: combinedSystemInstruction,
    });
  }

  for (const entry of params.history || []) {
    const content = normalizeMessage(entry?.content);
    if (!content) continue;

    messages.push({
      role: entry.role === "user" ? "user" : "assistant",
      content,
    });
  }

  messages.push({
    role: "user",
    content: normalizeMessage(params.currentMessage) || "(vazia)",
  });

  return messages;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("")
    .trim();
}

export async function initializeNewAIChatSession(
  chatId: string
): Promise<void> {
  void chatId;
  await getAssistantConfig();
}

export async function mainOpenAI({
  currentMessage,
  systemInstruction,
  history,
  chatId,
}: {
  currentMessage: string;
  systemInstruction?: string | null;
  history?: OpenAIHistoryTurn[];
  chatId: string;
}): Promise<string> {
  void chatId;

  const openai = getOpenAIClient();
  const assistantConfig = await getAssistantConfig();
  const messages = buildMessages({
    assistantInstructions: assistantConfig.instructions,
    systemInstruction,
    history,
    currentMessage,
  });

  const response = await openai.chat.completions.create({
    model: assistantConfig.model,
    messages,
  });

  const text = extractTextContent(response.choices?.[0]?.message?.content);
  return text || "Sem resposta.";
}
