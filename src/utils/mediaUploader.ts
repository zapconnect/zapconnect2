import crypto from "crypto";
import fs from "fs";
import path from "path";

export type MediaBufferPayload = {
  buffer: Buffer;
  filename: string;
  dataUrl?: string;
  base64?: string;
};

function sanitizeLocalFilename(filename: string): string {
  const base = path.basename(filename || "arquivo");
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_");
  return cleaned.slice(-180) || "arquivo";
}

export function persistMediaBufferToLocalFile(
  rootDir: string,
  ownerId: number | string,
  file: MediaBufferPayload
): string {
  const dir = path.join(rootDir, String(ownerId));
  fs.mkdirSync(dir, { recursive: true });

  const safeName = sanitizeLocalFilename(file.filename);
  const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${safeName}`;
  const absPath = path.join(dir, unique);

  fs.writeFileSync(absPath, file.buffer);
  return absPath;
}

export function releaseMediaPayload(file?: MediaBufferPayload | null) {
  if (!file) return;

  file.buffer = Buffer.alloc(0);
  if ("dataUrl" in file) file.dataUrl = "";
  if ("base64" in file) file.base64 = "";
}

export function cleanupLocalMediaFile(absPath?: string | null) {
  if (!absPath) return;

  try {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  } catch {}
}
