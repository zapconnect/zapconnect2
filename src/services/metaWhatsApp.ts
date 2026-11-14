import crypto from "crypto";
import axios from "axios";
import FormData from "form-data";
import { getDB } from "../database";
import { emitToUser } from "../lib/socketEmitter";

const GRAPH_API_VERSION = /^v\d+\.\d+$/.test(String(process.env.META_GRAPH_API_VERSION || ""))
  ? String(process.env.META_GRAPH_API_VERSION)
  : "v27.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const WHATSAPP_24_HOUR_WINDOW_MS = 24 * 60 * 60 * 1000;

export function getWhatsAppClientSendTimeout(client: any, fallbackMs: number, isFile = false) {
  if (!client?.isMetaCloudApi) return fallbackMs;
  return Math.max(fallbackMs, isFile ? 90_000 : 30_000);
}

type MetaCloudClientOptions = {
  userId: number;
  sessionName: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  displayPhoneNumber?: string | null;
};

type MetaMessageHandler = (message: any) => void | Promise<void>;
type MetaAckHandler = (ack: any) => void | Promise<void>;

function requireEncryptionKey(): Buffer {
  const raw = String(process.env.META_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!/^[a-f\d]{64}$/i.test(raw)) {
    throw new Error("Configure META_TOKEN_ENCRYPTION_KEY com 64 caracteres hexadecimais (32 bytes)." );
  }
  return Buffer.from(raw, "hex");
}

export function encryptMetaAccessToken(token: string): string {
  const key = requireEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptMetaAccessToken(value: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = String(value || "").split(":");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Credencial Meta criptografada em formato inválido.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    requireEncryptionKey(),
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function getMetaSignupConfig() {
  const appId = String(process.env.META_APP_ID || "").trim();
  const configId = String(process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || "").trim();
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  const webhookVerifyToken = String(process.env.META_WEBHOOK_VERIFY_TOKEN || "").trim();
  let encryptionKeyReady = false;
  try {
    requireEncryptionKey();
    encryptionKeyReady = true;
  } catch { }

  return {
    appId,
    configId,
    graphApiVersion: GRAPH_API_VERSION,
    configured: Boolean(appId && configId && appSecret && webhookVerifyToken && encryptionKeyReady),
    missing: [
      !appId ? "META_APP_ID" : "",
      !configId ? "META_EMBEDDED_SIGNUP_CONFIG_ID" : "",
      !appSecret ? "META_APP_SECRET" : "",
      !webhookVerifyToken ? "META_WEBHOOK_VERIFY_TOKEN" : "",
      !encryptionKeyReady ? "META_TOKEN_ENCRYPTION_KEY" : "",
    ].filter(Boolean),
  };
}

export function verifyMetaWebhookSignature(rawBody: Buffer, signatureHeader: unknown): boolean {
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  const signature = String(signatureHeader || "").trim();
  if (!appSecret || !/^sha256=[a-f\d]{64}$/i.test(signature)) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getAppSecretProof(accessToken: string): string | undefined {
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  if (!appSecret) return undefined;
  return crypto.createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

export function countMetaTemplateParameters(bodyText: string): number {
  const placeholders = String(bodyText || "").match(/\{\{\s*\d+\s*\}\}/g) || [];
  return placeholders.reduce((largest, placeholder) => {
    const number = Number(placeholder.match(/\d+/)?.[0] || 0);
    return Math.max(largest, number);
  }, 0);
}

function graphErrorMessage(error: any): string {
  const apiMessage = String(error?.response?.data?.error?.message || "").trim();
  const apiCode = String(error?.response?.data?.error?.code || "").trim();
  if (apiMessage) return apiCode ? `${apiMessage} (código Meta ${apiCode})` : apiMessage;
  return String(error?.message || "Falha ao comunicar com a API da Meta.");
}

export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const { appId } = getMetaSignupConfig();
  const appSecret = String(process.env.META_APP_SECRET || "").trim();
  if (!appId || !appSecret) throw new Error("A configuração de acesso da Meta ainda não foi concluída.");

  try {
    const response = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
      timeout: 20_000,
    });
    const accessToken = String(response.data?.access_token || "").trim();
    if (!accessToken) throw new Error("A Meta não retornou um token de acesso válido.");
    return accessToken;
  } catch (error: any) {
    if (error?.message?.includes("token de acesso válido")) throw error;
    throw new Error(graphErrorMessage(error));
  }
}

export async function getMetaPhoneDetails(phoneNumberId: string, accessToken: string) {
  const response = await metaGraphRequest("GET", `/${encodeURIComponent(phoneNumberId)}`, accessToken, {
    fields: "display_phone_number,verified_name",
  });
  return {
    displayPhoneNumber: String(response?.display_phone_number || "").trim(),
    verifiedName: String(response?.verified_name || "").trim(),
  };
}

export async function registerMetaPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin: string
) {
  await metaGraphRequest("POST", `/${encodeURIComponent(phoneNumberId)}/register`, accessToken, {
    messaging_product: "whatsapp",
    pin,
  });
}

export async function subscribeMetaWaba(wabaId: string, accessToken: string) {
  await metaGraphRequest("POST", `/${encodeURIComponent(wabaId)}/subscribed_apps`, accessToken, {});
}

export async function metaGraphRequest(
  method: "GET" | "POST",
  path: string,
  accessToken: string,
  paramsOrBody: Record<string, unknown> = {}
): Promise<any> {
  const appsecretProof = getAppSecretProof(accessToken);
  try {
    const response = await axios.request({
      method,
      url: `${GRAPH_API_BASE}${path}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(method === "GET"
        ? { params: { ...paramsOrBody, ...(appsecretProof ? { appsecret_proof: appsecretProof } : {}) } }
        : { params: appsecretProof ? { appsecret_proof: appsecretProof } : undefined, data: paramsOrBody }),
      timeout: 25_000,
    });
    return response.data;
  } catch (error: any) {
    throw new Error(graphErrorMessage(error));
  }
}

function normalizeRecipient(chatId: string): string {
  const recipient = String(chatId || "").replace(/@(?:c\.us|s\.whatsapp\.net)$/i, "").replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(recipient)) {
    throw new Error("Número de WhatsApp inválido para a API Oficial.");
  }
  return recipient;
}

function mapMessageType(message: any): { type: string; body: string; mimetype: string | null; mediaId: string | null } {
  const type = String(message?.type || "text").toLowerCase();
  if (type === "text") {
    return { type, body: String(message?.text?.body || ""), mimetype: null, mediaId: null };
  }
  if (type === "button") {
    return { type, body: String(message?.button?.text || message?.button?.payload || ""), mimetype: null, mediaId: null };
  }
  if (type === "interactive") {
    const choice = message?.interactive?.button_reply || message?.interactive?.list_reply;
    return { type, body: String(choice?.title || choice?.id || ""), mimetype: null, mediaId: null };
  }
  if (type === "reaction") {
    return { type, body: String(message?.reaction?.emoji || "Reação"), mimetype: null, mediaId: null };
  }
  const media = message?.[type];
  const caption = String(media?.caption || "");
  const mime = String(media?.mime_type || "").trim() || (
    type === "image" ? "image/jpeg"
      : type === "audio" ? "audio/ogg"
        : type === "video" ? "video/mp4"
          : type === "document" ? "application/octet-stream" : null
  );
  return {
    type,
    body: caption || (type === "location" ? [message?.location?.name, message?.location?.address].filter(Boolean).join(" — ") : ""),
    mimetype: mime,
    mediaId: String(media?.id || "").trim() || null,
  };
}

export class MetaWhatsAppCloudClient {
  readonly isMetaCloudApi = true;
  readonly userId: number;
  readonly sessionName: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly displayPhoneNumber: string;
  private readonly accessToken: string;
  private messageHandlers: MetaMessageHandler[] = [];
  private ackHandlers: MetaAckHandler[] = [];
  private mediaDownloadCache = new Map<string, Promise<{ buffer: Buffer; mimetype: string }>>();

  constructor(options: MetaCloudClientOptions) {
    this.userId = options.userId;
    this.sessionName = options.sessionName;
    this.phoneNumberId = options.phoneNumberId;
    this.wabaId = options.wabaId;
    this.displayPhoneNumber = String(options.displayPhoneNumber || "");
    this.accessToken = options.accessToken;
  }

  onMessage(handler: MetaMessageHandler) { this.messageHandlers.push(handler); }
  onAck(handler: MetaAckHandler) { this.ackHandlers.push(handler); }
  onStateChange(_handler: (state: string) => void) { }
  async isConnected() { return true; }
  async openChat(_chatId: string) { return true; }
  async closeChat() { return true; }
  async startTyping(_chatId: string) { }
  async stopTyping(_chatId: string) { }
  async close() { this.messageHandlers = []; this.ackHandlers = []; }

  async checkNumberStatus(_number: string) {
    return { canReceiveMessage: true };
  }

  async dispatchIncoming(rawMessage: any, contactName = "") {
    const messageId = String(rawMessage?.id || "").trim();
    const phone = String(rawMessage?.from || "").replace(/\D/g, "");
    if (!messageId || !phone) return false;

    const mapped = mapMessageType(rawMessage);
    const timestampSeconds = Number(rawMessage?.timestamp || 0) || Math.floor(Date.now() / 1000);
    const timestampMs = timestampSeconds * 1000;
    const chatId = `${phone}@c.us`;
    const db = getDB();
    const result = await db.run(
      `INSERT IGNORE INTO meta_messages
        (user_id, session_name, chat_id, message_id, direction, body, message_type, media_id, mimetype, contact_name, delivery_status, timestamp_ms)
       VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, 'received', ?)`,
      [this.userId, this.sessionName, chatId, messageId, mapped.body, mapped.type, mapped.mediaId, mapped.mimetype, contactName || null, timestampMs]
    );
    if (!Number(result?.affectedRows || 0)) return false;

    const normalized = {
      id: { _serialized: messageId },
      messageId,
      chatId,
      from: chatId,
      fromMe: false,
      isGroupMsg: false,
      type: mapped.type === "audio" ? "audio" : mapped.type,
      body: mapped.body,
      text: mapped.body,
      caption: mapped.body,
      mimetype: mapped.mimetype,
      timestamp: timestampSeconds,
      sender: { pushname: contactName || phone, name: contactName || phone },
      __metaCloud: true,
      __metaMediaId: mapped.mediaId,
      __metaPanelEmitted: true,
    };
    emitToUser(this.userId, "newMessage", {
      chatId,
      sessionName: this.sessionName,
      name: contactName || phone,
      body: mapped.body,
      mimetype: mapped.mimetype,
      isMedia: Boolean(mapped.mediaId || mapped.mimetype),
      mediaUrl: mapped.mediaId
        ? `/sessions/meta/media/${encodeURIComponent(messageId)}?sessionName=${encodeURIComponent(this.sessionName)}`
        : null,
      timestamp: timestampMs,
      fromMe: false,
      _isFromMe: false,
      id: messageId,
      messageId,
    });
    for (const handler of this.messageHandlers) {
      Promise.resolve(handler(normalized)).catch((error) => {
        console.error("Erro ao processar mensagem recebida da Meta:", error?.message || error);
      });
    }
    return true;
  }

  async dispatchStatus(status: any) {
    const messageId = String(status?.id || "").trim();
    const state = String(status?.status || "").toLowerCase();
    if (!messageId) return;
    const ack = state === "read" ? 3 : state === "delivered" ? 2 : state === "sent" ? 1 : state === "failed" ? -1 : 0;
    const timestamp = Number(status?.timestamp || 0) || Math.floor(Date.now() / 1000);
    const failureReason = status?.errors?.[0]?.title || status?.errors?.[0]?.message || null;
    await getDB().run(
      `UPDATE meta_messages
       SET delivery_status = CASE
             WHEN delivery_status = 'read' THEN 'read'
             WHEN delivery_status = 'failed' AND ? <> 'read' THEN 'failed'
             WHEN delivery_status = 'delivered' AND ? = 'sent' THEN 'delivered'
             ELSE ? END,
           failed_reason = CASE WHEN ? = 'failed' THEN ? ELSE failed_reason END,
           updated_at_ms = ?
       WHERE user_id = ? AND session_name = ? AND message_id = ?`,
      [state, state, state || "unknown", state, failureReason, timestamp * 1000, this.userId, this.sessionName, messageId]
    );
    const recipient = String(status?.recipient_id || "").replace(/\D/g, "");
    const ackPayload = {
      id: { _serialized: messageId },
      ack,
      to: recipient ? `${recipient}@c.us` : "",
      t: timestamp,
    };
    for (const handler of this.ackHandlers) {
      Promise.resolve(handler(ackPayload)).catch((error) => {
        console.error("Erro ao processar status da mensagem Meta:", error?.message || error);
      });
    }
  }

  private async assertFreeformWindow(chatId: string) {
    const db = getDB();
    const lastInbound = await db.get<{ timestamp_ms: number | string }>(
      `SELECT timestamp_ms FROM meta_messages
       WHERE user_id = ? AND session_name = ? AND chat_id = ? AND direction = 'inbound'
       ORDER BY timestamp_ms DESC LIMIT 1`,
      [this.userId, this.sessionName, chatId]
    );
    const lastInboundAt = Number(lastInbound?.timestamp_ms || 0);
    if (!lastInboundAt || Date.now() - lastInboundAt >= WHATSAPP_24_HOUR_WINDOW_MS) {
      throw new Error("A janela de atendimento da Meta (24 horas) terminou. Envie um modelo aprovado pela Meta para iniciar uma nova conversa.");
    }
  }

  private async saveOutgoingMessage(chatId: string, messageId: string, body: string, type = "text", mimetype: string | null = null, mediaId: string | null = null) {
    const phone = normalizeRecipient(chatId);
    await getDB().run(
      `INSERT IGNORE INTO meta_messages
        (user_id, session_name, chat_id, message_id, direction, body, message_type, media_id, mimetype, delivery_status, timestamp_ms)
       VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, 'sent', ?)`,
      [this.userId, this.sessionName, `${phone}@c.us`, messageId, body, type, mediaId, mimetype, Date.now()]
    );
    emitToUser(this.userId, "newMessage", {
      chatId: `${phone}@c.us`,
      sessionName: this.sessionName,
      body,
      mimetype,
      isMedia: Boolean(mediaId || mimetype),
      mediaUrl: mediaId
        ? `/sessions/meta/media/${encodeURIComponent(messageId)}?sessionName=${encodeURIComponent(this.sessionName)}`
        : null,
      fromMe: true,
      _isFromMe: true,
      id: messageId,
      messageId,
      ack: 1,
      deliveryStatus: "sent",
      timestamp: Date.now(),
    });
    return { id: { _serialized: messageId }, messageId, ack: 1 };
  }

  async sendText(chatId: string, body: string) {
    const phone = normalizeRecipient(chatId);
    const normalizedChatId = `${phone}@c.us`;
    await this.assertFreeformWindow(normalizedChatId);
    const result = await metaGraphRequest("POST", `/${encodeURIComponent(this.phoneNumberId)}/messages`, this.accessToken, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { preview_url: false, body: String(body || "") },
    });
    const messageId = String(result?.messages?.[0]?.id || "");
    if (!messageId) throw new Error("A Meta não confirmou o envio da mensagem.");
    return this.saveOutgoingMessage(normalizedChatId, messageId, String(body || ""));
  }

  async sendFile(chatId: string, dataUrl: string, filename: string, caption = "") {
    const phone = normalizeRecipient(chatId);
    const normalizedChatId = `${phone}@c.us`;
    await this.assertFreeformWindow(normalizedChatId);
    const match = String(dataUrl || "").match(/^data:([^;,]+);base64,([a-z\d+/=]+)$/i);
    if (!match) throw new Error("O arquivo anexado não está em um formato válido para a API Oficial.");
    const mimetype = match[1];
    const buffer = Buffer.from(match[2], "base64");
    const mediaForm = new FormData();
    mediaForm.append("messaging_product", "whatsapp");
    mediaForm.append("file", buffer, { filename: filename || "arquivo", contentType: mimetype });

    let uploadResponse: any;
    try {
      uploadResponse = await axios.post(`${GRAPH_API_BASE}/${encodeURIComponent(this.phoneNumberId)}/media`, mediaForm, {
        headers: { ...mediaForm.getHeaders(), Authorization: `Bearer ${this.accessToken}` },
        params: getAppSecretProof(this.accessToken) ? { appsecret_proof: getAppSecretProof(this.accessToken) } : undefined,
        timeout: 60_000,
        maxBodyLength: 30 * 1024 * 1024,
      });
    } catch (error: any) {
      throw new Error(graphErrorMessage(error));
    }

    const mediaId = String(uploadResponse?.data?.id || "");
    if (!mediaId) throw new Error("A Meta não confirmou o upload do arquivo.");
    const mediaType = mimetype.startsWith("image/") ? "image"
      : mimetype.startsWith("video/") ? "video"
        : mimetype.startsWith("audio/") ? "audio" : "document";
    const mediaPayload: Record<string, unknown> = { id: mediaId };
    if (mediaType === "document") mediaPayload.filename = filename;
    if (caption && mediaType !== "audio") mediaPayload.caption = caption;
    const result = await metaGraphRequest("POST", `/${encodeURIComponent(this.phoneNumberId)}/messages`, this.accessToken, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: mediaType,
      [mediaType]: mediaPayload,
    });
    const messageId = String(result?.messages?.[0]?.id || "");
    if (!messageId) throw new Error("A Meta não confirmou o envio do arquivo.");
    return this.saveOutgoingMessage(normalizedChatId, messageId, caption || `[Arquivo: ${filename}]`, mediaType, mimetype, mediaId);
  }

  async sendTemplate(chatId: string, name: string, languageCode: string, bodyParameters: string[] = []) {
    const phone = normalizeRecipient(chatId);
    const templates = await this.listApprovedBodyTemplates();
    const selected = templates.find((template: any) => template.name === name && template.language === languageCode);
    if (!selected) throw new Error("Selecione um modelo aprovado pela Meta para este número.");

    const bodyComponent = (selected.components || []).find((component: any) => String(component.type).toUpperCase() === "BODY");
    const variableCount = countMetaTemplateParameters(String(bodyComponent?.text || ""));
    if (bodyParameters.length !== variableCount) {
      throw new Error(`Este modelo precisa de ${variableCount} parâmetro(s) no corpo.`);
    }
    const components = variableCount
      ? [{ type: "body", parameters: bodyParameters.map((text) => ({ type: "text", text })) }]
      : [];
    const result = await metaGraphRequest("POST", `/${encodeURIComponent(this.phoneNumberId)}/messages`, this.accessToken, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "template",
      template: { name, language: { code: languageCode }, ...(components.length ? { components } : {}) },
    });
    const messageId = String(result?.messages?.[0]?.id || "");
    if (!messageId) throw new Error("A Meta não confirmou o envio do modelo.");
    const preview = String(bodyComponent?.text || name).replace(/\{\{\s*(\d+)\s*\}\}/g, (_all, n) => bodyParameters[Number(n) - 1] || "");
    const saved = await this.saveOutgoingMessage(`${phone}@c.us`, messageId, preview, "template");
    return { ...saved, preview };
  }

  async listApprovedBodyTemplates() {
    const response = await metaGraphRequest("GET", `/${encodeURIComponent(this.wabaId)}/message_templates`, this.accessToken, {
      fields: "name,language,status,category,components",
      limit: 100,
    });
    return (Array.isArray(response?.data) ? response.data : []).filter((template: any) => {
      if (String(template?.status || "").toUpperCase() !== "APPROVED") return false;
      const components = Array.isArray(template?.components) ? template.components : [];
      const hasTextBody = components.some((component: any) =>
        String(component?.type || "").toUpperCase() === "BODY" && String(component?.text || "").trim()
      );
      return hasTextBody && components.every((component: any) =>
        ["BODY", "FOOTER"].includes(String(component?.type || "").toUpperCase())
      );
    });
  }

  async decryptFile(message: any): Promise<Buffer> {
    const mediaId = String(message?.__metaMediaId || message?.mediaId || "").trim();
    if (!mediaId) throw new Error("A mensagem não contém mídia para baixar.");
    let pending = this.mediaDownloadCache.get(mediaId);
    if (!pending) {
      pending = (async () => {
        const metadata = await metaGraphRequest("GET", `/${encodeURIComponent(mediaId)}`, this.accessToken, {});
        const mediaUrl = String(metadata?.url || "");
        if (!mediaUrl) throw new Error("A Meta não retornou o endereço da mídia.");
        const response = await axios.get(mediaUrl, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          responseType: "arraybuffer",
          timeout: 40_000,
        });
        return {
          buffer: Buffer.from(response.data),
          mimetype: String(metadata?.mime_type || response.headers?.["content-type"] || "application/octet-stream"),
        };
      })();
      this.mediaDownloadCache.set(mediaId, pending);
      setTimeout(() => this.mediaDownloadCache.delete(mediaId), 5 * 60 * 1000).unref?.();
    }
    const downloaded = await pending;
    message.mimetype = downloaded.mimetype;
    return downloaded.buffer;
  }

  async listChats() {
    const rows = await getDB().all<any>(
      `SELECT chat_id, contact_name, body, mimetype, direction, timestamp_ms
       FROM meta_messages
       WHERE user_id = ? AND session_name = ?
       ORDER BY timestamp_ms DESC
       LIMIT 2000`,
      [this.userId, this.sessionName]
    );
    const seen = new Set<string>();
    const chats: any[] = [];
    for (const row of rows) {
      const chatId = String(row.chat_id || "");
      if (!chatId || seen.has(chatId)) continue;
      seen.add(chatId);
      const phone = chatId.replace(/@.*/, "");
      chats.push({
        id: { _serialized: chatId, user: phone },
        name: String(row.contact_name || phone),
        formattedName: String(row.contact_name || phone),
        isGroup: false,
        lastMessage: { body: String(row.body || "") },
        timestamp: Math.floor(Number(row.timestamp_ms || Date.now()) / 1000),
      });
    }
    return chats;
  }

  async getAllMessagesInChat(chatId: string, _includeMe = true, _includeNotifications = false) {
    const normalizedChatId = chatId.includes("@") ? chatId : `${normalizeRecipient(chatId)}@c.us`;
    const rows = await getDB().all<any>(
      `SELECT message_id, direction, body, message_type, media_id, mimetype, delivery_status, timestamp_ms
       FROM meta_messages
       WHERE user_id = ? AND session_name = ? AND chat_id = ?
       ORDER BY timestamp_ms DESC
       LIMIT 500`,
      [this.userId, this.sessionName, normalizedChatId]
    );
    return rows.reverse().map((row) => ({
      chatId: normalizedChatId,
      id: { _serialized: row.message_id },
      messageId: row.message_id,
      body: row.body || "",
      type: row.message_type,
      mimetype: row.mimetype || null,
      mediaId: row.media_id || null,
      fromMe: row.direction === "outbound",
      timestamp: Math.floor(Number(row.timestamp_ms || Date.now()) / 1000),
      ack: row.delivery_status === "read" ? 3 : row.delivery_status === "delivered" ? 2 : 1,
      deliveryStatus: row.delivery_status,
    }));
  }
}

