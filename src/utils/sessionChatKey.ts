export function createSessionChatKey(
  userId: number | string,
  sessionName: string,
  chatId: string
): string {
  return `USER${String(userId).trim()}::${encodeURIComponent(String(sessionName).trim())}::${chatId}`;
}
