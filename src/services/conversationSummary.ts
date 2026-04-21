import { getDB } from "../database";
import { mainGoogle } from "../service/google";

type HistoryEntry = { role: "user" | "model"; parts: { text: string }[] };

function buildTranscript(raw: any): string | null {
  if (!Array.isArray(raw)) return null;
  const trimmed = (raw as HistoryEntry[])
    .slice(-14) // pega só o final da conversa
    .map((h) => {
      const who = h.role === "user" ? "Cliente" : "IA";
      const txt = (h.parts || [])
        .map((p) => p?.text || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!txt) return null;
      return `${who}: ${txt}`;
    })
    .filter(Boolean) as string[];

  if (!trimmed.length) return null;
  return trimmed.join("\n");
}

async function saveNoteToCrm({
  userId,
  phone,
  text,
}: {
  userId: number;
  phone: string;
  text: string;
}) {
  const db = getDB();
  const client = await db.get<{ id: number; notes: string | null }>(
    `SELECT id, notes FROM crm WHERE user_id = ? AND phone = ?`,
    [userId, phone]
  );
  if (!client?.id) return;

  let notesArr: any[] = [];
  try {
    notesArr = client.notes ? JSON.parse(client.notes) : [];
  } catch {
    notesArr = [];
  }

  notesArr.unshift({
    text,
    created_at: Date.now(),
    kind: "auto_summary",
  });

  await db.run(`UPDATE crm SET notes = ? WHERE id = ?`, [
    JSON.stringify(notesArr),
    client.id,
  ]);
}

export async function summarizeConversationToCrm({
  userId,
  sessionName,
  chatId,
}: {
  userId: number;
  sessionName: string;
  chatId: string;
}) {
  try {
    const db = getDB();
    const row = await db.get<{ history: string | null }>(
      `SELECT history
       FROM chat_histories
       WHERE user_id = ? AND chat_id = ?
       LIMIT 1`,
      [userId, chatId]
    );
    if (!row?.history) return;

    let history: any = null;
    try {
      history = JSON.parse(row.history);
    } catch {
      return;
    }

    const transcript = buildTranscript(history);
    if (!transcript) return;

    const prompt = [
      "Resuma a conversa a seguir em 3 a 5 bullets curtos, enfatizando:",
      "- Pedido ou problema do cliente",
      "- Solução/ação dada ou status atual",
      "- Próximos passos ou pendências, se existirem",
      "Use português, seja conciso e evite dados sensíveis.",
      "",
      transcript,
    ].join("\n");

    let summary = "";
    try {
      summary = await mainGoogle({
        currentMessage: prompt,
        userMessage: prompt,
        systemInstruction: "",
        chatId: `${chatId}::summary`,
        userId,
        sessionName,
        onStream: undefined,
      });
    } catch (err) {
      console.warn("Falha ao gerar resumo (Google):", err);
      // fallback simples: pega primeiras linhas da transcrição
      summary =
        "Resumo automático (fallback): " +
        transcript
          .split("\n")
          .slice(0, 3)
          .join(" ")
          .slice(0, 400);
    }

    if (!summary.trim()) return;

    const phone = chatId.replace(/@.*/, "");
    await saveNoteToCrm({ userId, phone, text: summary.trim() });
  } catch (err) {
    console.warn("Erro no resumo automático:", err);
  }
}
