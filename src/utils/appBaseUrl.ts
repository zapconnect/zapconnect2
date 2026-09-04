const DEFAULT_HTTP_PORT = 3000;

function normalizeUrlValue(value: string | undefined) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function getHttpPort(rawValue = process.env.PORT): number {
  const normalized = String(rawValue || "").trim();
  if (!normalized) return DEFAULT_HTTP_PORT;

  const port = Number(normalized);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    return port;
  }

  console.warn(`PORT inválida "${normalized}". Usando ${DEFAULT_HTTP_PORT}.`);
  return DEFAULT_HTTP_PORT;
}

export const HTTP_PORT = getHttpPort();

export function getBaseUrl(rawValue = process.env.BASE_URL, port = HTTP_PORT) {
  const explicit = normalizeUrlValue(rawValue);
  return explicit || `http://localhost:${port}`;
}

export const BASE_URL = getBaseUrl();

export function buildPortInUseHelp(port = HTTP_PORT) {
  const suggestedPort = port === DEFAULT_HTTP_PORT ? DEFAULT_HTTP_PORT + 1 : port + 1;
  const suggestedBaseUrl = `http://localhost:${suggestedPort}`;

  return [
    `A porta ${port} já está em uso.`,
    "Já existe outra instância do app rodando nessa porta.",
    `Pare a instância atual ou inicie esta cópia com PORT=${suggestedPort}.`,
    `Se mudar a porta, ajuste também BASE_URL=${suggestedBaseUrl}.`,
    `Se você definiu GOOGLE_REDIRECT_URI manualmente, atualize-o para ${suggestedBaseUrl}/auth/google/callback ou deixe a variável vazia para o app derivar esse valor do BASE_URL.`,
  ].join(" ");
}
