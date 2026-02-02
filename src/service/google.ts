// =====================================
// 🤖 Gemini Multiusuário + Multi-Sessão
// =====================================
import { GoogleGenerativeAI, type ChatSession } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Histórico das conversas (por sessão completa)
type ChatHistory = {
  role: 'user' | 'model';
  parts: { text: string }[];
}[];

const activeChats = new Map<string, ChatHistory>();

// =======================================
// 🔑 Create Key: user + session + chat ID
// =======================================
const buildChatKey = (
  userId: number,
  sessionName: string,
  chatId: string
) => `USER${userId}_${sessionName}::${chatId}`;

// =======================================
// 📌 Iniciar/Retomar Sessão Gemini
// =======================================
const getOrCreateChatSession = ({
  chatKey,
  promptUsuario,
}: {
  chatKey: string;
  promptUsuario: string;
}): ChatSession => {
  if (activeChats.has(chatKey)) {
    return model.startChat({ history: activeChats.get(chatKey)! });
  }

  // Primeira conexão do usuário
  const history: ChatHistory = [
    {
      role: 'user',
      parts: [{ text: promptUsuario }],
    },
    {
      role: 'model',
      parts: [{ text: 'Olá! Em que posso te ajudar?' }],
    },
  ];

  activeChats.set(chatKey, history);
  return model.startChat({ history });
};

// =======================================
// 🧠 Função principal da IA Gemini
// =======================================
export const mainGoogle = async ({
  currentMessage,
  chatId,
  userId,
  sessionName,
  promptUsuario,
}: {
  currentMessage: string;
  chatId: string;
  userId: number;
  sessionName: string;
  promptUsuario: string;
}): Promise<string> => {
  const chatKey = buildChatKey(userId, sessionName, chatId);

  try {
    const chat = getOrCreateChatSession({ chatKey, promptUsuario });
    const result = await chat.sendMessage(currentMessage);
    const text = result.response?.text?.() || "Sem resposta.";

    // Salvar histórico
    const history = activeChats.get(chatKey) || [];
    history.push(
      { role: 'user', parts: [{ text: currentMessage }] },
      { role: 'model', parts: [{ text }] }
    );

    // ⛔ Evita excesso de histórico (mantém últimos 16 turnos)
    if (history.length > 32) history.splice(0, history.length - 32);

    activeChats.set(chatKey, history);

    console.log(`📩 Gemini Resposta (${chatKey}):`, text);
    return text;

  } catch (err: any) {
    console.error(`❌ Erro IA tentativa:`, err?.status, err?.message);

    // 🛑 Caso seja erro de cota -> resposta amigável
    if (err?.status === 429) {
      return "⚠️ A IA está temporariamente indisponível devido ao limite de uso. Tente novamente dentro de alguns minutos.";
    }

    return "❌ Ocorreu um erro inesperado ao tentar responder.";
  }
};

// =======================================
// 🛑 Nova função para encerrar o chat
// =======================================
export const stopChatSession = (
  userId: number,
  sessionName: string,
  chatId: string
): void => {
  const chatKey = buildChatKey(userId, sessionName, chatId);

  if (activeChats.has(chatKey)) {
    activeChats.delete(chatKey);
    console.log(`🔥 Chat encerrado -> ${chatKey}`);
  } else {
    console.log(`⚠️ Nenhuma sessão ativa encontrada para -> ${chatKey}`);
  }
};
