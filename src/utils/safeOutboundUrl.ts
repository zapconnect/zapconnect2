import { lookup } from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "0.0.0.0",
  "::",
  "::1",
  "metadata.google.internal",
]);

export class UnsafeOutboundUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeOutboundUrlError";
  }
}

function normalizeHost(rawHost: string) {
  return String(rawHost || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isReservedIpv4(host: string) {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function extractMappedIpv4(host: string) {
  const match = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return match?.[1] || null;
}

function isReservedIpv6(host: string) {
  const normalized = normalizeHost(host);
  const mappedIpv4 = extractMappedIpv4(normalized);
  if (normalized.startsWith("::ffff:")) {
    return mappedIpv4 ? isReservedIpv4(mappedIpv4) : true;
  }

  if (mappedIpv4) {
    return isReservedIpv4(mappedIpv4);
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fec") ||
    normalized.startsWith("fed") ||
    normalized.startsWith("fee") ||
    normalized.startsWith("fef") ||
    normalized.startsWith("ff")
  );
}

function assertSafeLiteralHost(host: string) {
  if (!host) {
    throw new UnsafeOutboundUrlError("Host ausente");
  }

  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new UnsafeOutboundUrlError("URL aponta para host interno");
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4 && isReservedIpv4(host)) {
    throw new UnsafeOutboundUrlError("URL aponta para endereco IPv4 nao publico");
  }

  if (ipVersion === 6 && isReservedIpv6(host)) {
    throw new UnsafeOutboundUrlError("URL aponta para endereco IPv6 nao publico");
  }
}

export function parseSafeOutboundHttpUrl(rawUrl: string) {
  let parsed: URL;

  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new UnsafeOutboundUrlError("URL invalida");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new UnsafeOutboundUrlError("Apenas URLs HTTP/HTTPS sao permitidas");
  }

  assertSafeLiteralHost(normalizeHost(parsed.hostname));
  return parsed;
}

export async function assertSafeOutboundHttpUrl(rawUrl: string) {
  const parsed = parseSafeOutboundHttpUrl(rawUrl);
  const host = normalizeHost(parsed.hostname);

  if (net.isIP(host)) {
    return parsed;
  }

  const results = await lookup(host, { all: true });
  if (!results.length) {
    throw new UnsafeOutboundUrlError("Host nao pode ser resolvido");
  }

  const resolvedUnsafe = results.some((result) => {
    if (result.family === 4) {
      return isReservedIpv4(result.address);
    }

    if (result.family === 6) {
      return isReservedIpv6(result.address);
    }

    return true;
  });

  if (resolvedUnsafe) {
    throw new UnsafeOutboundUrlError(
      "URL resolve para um endereco interno ou nao publico"
    );
  }

  return parsed;
}

export function resolveSafeOutboundRedirectUrl(baseUrl: string, location: string) {
  try {
    return new URL(String(location || "").trim(), baseUrl).toString();
  } catch {
    throw new UnsafeOutboundUrlError("Redirecionamento invalido");
  }
}
