import { type Whatsapp } from '@wppconnect-team/wppconnect';

/**
 * ✂️ Divide mensagens sem quebrar links, PDF, JSON, números e e-mails
 */
export function splitMessages(text: string): string[] {
  if (!text) return [];

  const complexPattern =
    /(http[s]?:\/\/[^\s]+)|(www\.[^\s]+)|([^\s]+@[^\s]+\.[^\s]+)|(["'].*?["'])|(\b\d+\.\s)|(\w+\.\w+)/g;
  const placeholders = text.match(complexPattern) ?? [];

  const placeholder = 'PLACEHOLDER_';
  let index = 0;

  const withPlaceholders = text.replace(
    complexPattern,
    () => `${placeholder}${index++}`
  );

  const splitPattern = /(?<!\b\d+\.\s)(?<!\w+\.\w+)[^.?!]+(?:[.?!]+["']?|$)/g;
  let parts = (withPlaceholders.match(splitPattern) ?? []).map((p) => p.trim());

  if (placeholders.length > 0) {
    parts = parts.map((part) =>
      placeholders.reduce(
        (acc, val, idx) => acc.replace(`${placeholder}${idx}`, val),
        part
      )
    );
  }

  return parts.filter((p) => p.length > 0);
}

/**
 * 💬 Envia mensagens com digitação contínua e tempo realista + emite ao painel em tempo real
 */
export async function sendMessagesWithDelay({
  messages,
  client,
  targetNumber,
}: {
  messages: string[];
  client: Whatsapp;
  targetNumber: string;
}): Promise<void> {
  const chatId = targetNumber.toString();

  try { await client.startTyping(chatId); } catch {}

  for (const msg of messages) {
    if (!msg) continue;

    // Espera aleatória entre 2 e 5 segundos para simular comportamento humano
    const randomDelay = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
    await new Promise(resolve => setTimeout(resolve, randomDelay));

    try {
      await client.sendText(chatId, msg.trimStart());
      console.log('📤 Mensagem enviada:', msg);

      try {
        const { io } = await import("../server");
        io.emit("newMessage", {
          chatId,
          body: msg.trimStart(),
          timestamp: Date.now(),
          fromBot: true,
          _isFromMe: true,
          name: "🤖 Bot"
        });
      } catch (err) {
        console.error("⚠️ Falha ao emitir para painel:", err);
      }

    } catch (erro) {
      console.error('⚠️ Erro ao enviar mensagem:', erro);
    }
  }

  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await client.stopTyping(chatId);
  } catch {}
}
