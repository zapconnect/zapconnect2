import { type Whatsapp } from "@wppconnect-team/wppconnect";
import {
  assertSessionCanSend,
  calculateTypingDelay,
  getMessageContinuationDelay,
  getPostTypingDelay,
  recordSessionSend,
} from "../utils/humanDelay";

/**
 * Divide mensagens em partes legiveis, preservando links/e-mails e evitando cortar frases.
 * Regras:
 *  - prioridade para quebras por paragrafo (linhas em branco)
 *  - depois por frases (., !, ?)
 *  - limite de ~800 caracteres por parte com fallback seguro
 */
export function splitMessages(text: string): string[] {
  if (!text) return [];

  const MAX_LEN = 800;

  // Protege links/emails colocando placeholders
  const complexPattern =
    /(http[s]?:\/\/[^\s]+)|(www\.[^\s]+)|([^\s]+@[^\s]+\.[^\s]+)/g;
  const placeholders = (text.match(complexPattern) as string[]) ?? [];
  const placeholder = "PLACEHOLDER_";
  let phIndex = 0;

  const withPlaceholders = text.replace(
    complexPattern,
    () => `${placeholder}${phIndex++}`
  );

  // 1) Quebra por paragrafo duplo
  const paragraphs = withPlaceholders
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];

  const emitChunk = (chunk: string) => {
    // Restitui placeholders
    let restored = chunk;
    placeholders.forEach((val, idx) => {
      restored = restored.replaceAll(`${placeholder}${idx}`, val);
    });
    restored = restored.trim();
    if (restored.length) chunks.push(restored);
  };

  const splitParagraph = (para: string) => {
    if (para.length <= MAX_LEN) {
      emitChunk(para);
      return;
    }

    // 2) Quebra por frases ou emojis (emoji conta como parte isolada)
    const sentences =
      [...para.matchAll(/(\p{Extended_Pictographic}|[^.?!]+[.?!]?)/gu)]
        .map((m) => m[1]?.trim() ?? "")
        .filter(Boolean) ?? [para];

    let buffer = "";
    for (const s of sentences) {
      if ((buffer + " " + s).trim().length <= MAX_LEN) {
        buffer = (buffer ? buffer + " " : "") + s;
      } else {
        if (buffer) emitChunk(buffer);
        if (s.length <= MAX_LEN) {
          buffer = s;
        } else {
          // 3) Fallback duro: corta em blocos de MAX_LEN
          for (let i = 0; i < s.length; i += MAX_LEN) {
            emitChunk(s.slice(i, i + MAX_LEN));
          }
          buffer = "";
        }
      }
    }
    if (buffer) emitChunk(buffer);
  };

  for (const p of paragraphs) {
    splitParagraph(p);
  }

  return chunks;
}

function resolveSessionThrottleKey(client: Whatsapp, sessionName?: string): string {
  const inferredSession =
    sessionName ||
    (client as any)?.session ||
    (client as any)?.sessionName ||
    (client as any)?.options?.session;

  return typeof inferredSession === "string" && inferredSession.trim()
    ? inferredSession.trim()
    : "shared-wpp-session";
}

/**
 * Envia mensagens com digitacao continua e tempo realista + emite ao painel em tempo real.
 */
export async function sendMessagesWithDelay({
  messages,
  client,
  targetNumber,
  sessionName,
}: {
  messages: string[];
  client: Whatsapp;
  targetNumber: string;
  sessionName?: string;
}): Promise<void> {
  const chatId = targetNumber.toString();
  const sessionThrottleKey = resolveSessionThrottleKey(client, sessionName);

  for (const [index, rawMessage] of messages.entries()) {
    const msg = String(rawMessage || "");
    const trimmedMessage = msg.trimStart();
    if (!trimmedMessage) continue;

    assertSessionCanSend(sessionThrottleKey);

    if (index > 0) {
      const previousMessage = messages[index - 1] || "";
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          getMessageContinuationDelay(previousMessage, trimmedMessage)
        )
      );
    }

    try {
      await client.startTyping(chatId);
    } catch {}

    const typingDelayMs = calculateTypingDelay(trimmedMessage, sessionThrottleKey);
    await new Promise((resolve) => setTimeout(resolve, typingDelayMs));

    try {
      await client.stopTyping(chatId);
    } catch {}

    await new Promise((resolve) =>
      setTimeout(resolve, getPostTypingDelay())
    );

    try {
      await client.sendText(chatId, trimmedMessage);
      recordSessionSend(sessionThrottleKey);
      console.log("Mensagem enviada:", trimmedMessage);

      try {
        const { io } = await import("../server");
        io.emit("newMessage", {
          chatId,
          body: trimmedMessage,
          timestamp: Date.now(),
          fromBot: true,
          _isFromMe: true,
          name: "Bot",
        });
      } catch (err) {
        console.error("Falha ao emitir para painel:", err);
      }
    } catch (erro) {
      console.error("Erro ao enviar mensagem:", erro);
    }
  }

  try {
    await client.stopTyping(chatId);
  } catch {}
}
