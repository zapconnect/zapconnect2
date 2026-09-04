import {
  appendChatHistoryEntries,
  clearChatHistory,
  type PersistedChatHistoryEntry,
} from "./chatHistoryService";
import {
  clearGoogleRuntimeHistory,
  syncGoogleRuntimeHistory,
} from "../service/google";

export async function appendConversationHistoryEntries(params: {
  userId: number;
  sessionName: string;
  chatId: string;
  entries: PersistedChatHistoryEntry[];
}): Promise<void> {
  await appendChatHistoryEntries(params);
  syncGoogleRuntimeHistory({
    userId: params.userId,
    chatId: params.chatId,
    entries: params.entries,
  });
}

export async function clearConversationHistory(params: {
  userId: number;
  chatId: string;
}): Promise<void> {
  clearGoogleRuntimeHistory(params.userId, params.chatId);
  await clearChatHistory(params.userId, params.chatId);
}
