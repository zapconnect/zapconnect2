import { gunzip, gzip } from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function looksLikeGzipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function parseJsonValue<T>(raw: string): T | null {
  const normalized = String(raw || "").trim();
  if (!normalized) return null;
  return JSON.parse(normalized) as T;
}

export async function encodeCompressedJson(value: unknown): Promise<Buffer> {
  const json = JSON.stringify(value ?? null);
  return gzipAsync(Buffer.from(json, "utf8"));
}

export async function decodeCompressedJson<T = unknown>(
  raw: Buffer | string | null | undefined
): Promise<T | null> {
  if (raw == null) return null;

  if (Buffer.isBuffer(raw)) {
    if (!raw.length) return null;

    if (looksLikeGzipBuffer(raw)) {
      const decompressed = await gunzipAsync(raw);
      return parseJsonValue<T>(decompressed.toString("utf8"));
    }

    return parseJsonValue<T>(raw.toString("utf8"));
  }

  return parseJsonValue<T>(String(raw));
}
