import axios from "axios";
import pdfParse from "pdf-parse";
import { getDB } from "../database";
import path from "path";
import fs from "fs";

type KbSourceType = "text" | "url" | "file";

type ChunkRow = {
  id: number;
  content: string;
  embedding: any;
  source_id: number;
  user_id: number;
};

const DEFAULT_CHUNK_SIZE = 600; // chars
const DEFAULT_OVERLAP = 120; // chars
const MAX_CHUNKS_PER_SOURCE = 500;

function sanitizeText(raw: string): string {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html: string): string {
  return sanitizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function chunkText(text: string, size = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP): string[] {
  const clean = sanitizeText(text);
  if (!clean) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length && chunks.length < MAX_CHUNKS_PER_SOURCE) {
    const end = Math.min(clean.length, i + size);
    chunks.push(clean.slice(i, end));
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9á-úà-ùâ-ûã-õç]+/gi, " ")
    .split(" ")
    .filter(Boolean);
}

function vectorize(text: string): Record<string, number> {
  const tokens = tokenize(text);
  const vec: Record<string, number> = {};
  for (const t of tokens) {
    vec[t] = (vec[t] || 0) + 1;
  }
  return vec;
}

function cosineSim(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of Object.entries(a)) {
    if (b[k]) dot += v * b[k];
    na += v * v;
  }
  for (const v of Object.values(b)) nb += v * v;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function detectTypeFromName(name: string): KbSourceType | "pdf" | "docx" | "txt" | "unknown" {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".txt") return "txt";
  return "unknown";
}

async function extractTextFromBuffer(buffer: Buffer, filename: string): Promise<string> {
  const kind = detectTypeFromName(filename);
  if (kind === "pdf") {
    const data = await pdfParse(buffer);
    return data.text || "";
  }
  if (kind === "txt") {
    return buffer.toString("utf-8");
  }
  // fallback: try utf-8
  return buffer.toString("utf-8");
}

export async function ingestTextSource(params: {
  userId: number;
  name: string;
  content: string;
  sessionScope?: string | null;
  type?: KbSourceType;
}) {
  const { userId, name, content, sessionScope = null, type = "text" } = params;
  const db = getDB();
  const now = Date.now();
  const source = await db.run(
    `INSERT INTO kb_sources (user_id, type, name, source_url, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'pending', ?, ?)`,
    [userId, type, name, now, now]
  );
  const sourceId = source.insertId;

  const chunks = chunkText(content);
  let chunkCount = 0;
  let tokenCount = 0;
  for (let idx = 0; idx < chunks.length; idx++) {
    const c = chunks[idx];
    tokenCount += tokenize(c).length;
    await db.run(
      `INSERT INTO kb_chunks (source_id, user_id, session_scope, chunk_index, content, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sourceId, userId, sessionScope, idx, c, JSON.stringify(vectorize(c)), now]
    );
    chunkCount++;
  }

  await db.run(
    `UPDATE kb_sources SET status = 'ready', tokens = ?, chunks = ?, updated_at = ? WHERE id = ?`,
    [tokenCount, chunkCount, now, sourceId]
  );

  return { sourceId, chunks: chunkCount, tokens: tokenCount };
}

export async function ingestFileSource(params: {
  userId: number;
  filename: string;
  data: Buffer;
  sessionScope?: string | null;
}) {
  const { userId, filename, data, sessionScope = null } = params;
  const kbDir = path.join(process.cwd(), "kb_uploads", String(userId));
  fs.mkdirSync(kbDir, { recursive: true });
  const storedPath = path.join(kbDir, `${Date.now()}-${path.basename(filename)}`);
  fs.writeFileSync(storedPath, data);

  const text = await extractTextFromBuffer(data, filename);
  if (!text.trim()) {
    return { error: "Arquivo sem texto extraível" };
  }

  const name = filename || "Arquivo";
  return ingestTextSource({
    userId,
    name,
    content: text,
    sessionScope,
    type: "file",
  });
}

export async function ingestUrlSource(params: {
  userId: number;
  url: string;
  name?: string;
  sessionScope?: string | null;
}) {
  const { userId, url, sessionScope = null } = params;
  const name = params.name || url;
  try {
    const res = await axios.get(url, { timeout: 10000 });
    const text = stripHtml(res.data || "");
    if (!text) throw new Error("Conteúdo vazio");
    return ingestTextSource({ userId, name, content: text, sessionScope, type: "url" });
  } catch (err: any) {
    const db = getDB();
    const now = Date.now();
    const source = await db.run(
      `INSERT INTO kb_sources (user_id, type, name, source_url, status, error, created_at, updated_at)
       VALUES (?, 'url', ?, ?, 'error', ?, ?, ?)`,
      [userId, name, url, String(err?.message || err || "erro"), now, now]
    );
    return { sourceId: source.insertId, error: true };
  }
}

export async function listSources(userId: number) {
  const db = getDB();
  return db.all(
    `SELECT id, type, name, source_url, status, error, tokens, chunks, created_at, updated_at
     FROM kb_sources
     WHERE user_id = ?
     ORDER BY id DESC`,
    [userId]
  );
}

export async function queryKb(params: {
  userId: number;
  query: string;
  sessionName?: string;
  chatId?: string;
  topK?: number;
}): Promise<{ content: string; sourceId: number; sourceName?: string; score: number }[]> {
  const { userId, query, sessionName, chatId, topK = 5 } = params;
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const PRE_FILTER_CANDIDATES = 80;
  const candidateLimit = Math.max(PRE_FILTER_CANDIDATES, topK * 5);
  const db = getDB();
  const started = Date.now();
  const qVec = vectorize(safeQuery);

  let rows: (ChunkRow & { name?: string; ft_score?: number })[] = [];
  try {
    rows = await db.all<ChunkRow & { name?: string; ft_score?: number }>(
      `SELECT kc.id, kc.content, kc.embedding, kc.source_id, ks.name, kc.user_id,
              MATCH(kc.content) AGAINST (? IN NATURAL LANGUAGE MODE) AS ft_score
       FROM kb_chunks kc
       JOIN kb_sources ks ON ks.id = kc.source_id
       WHERE kc.user_id = ? AND ks.status = 'ready'
         AND (kc.session_scope IS NULL OR kc.session_scope = ?)
         AND MATCH(kc.content) AGAINST (? IN NATURAL LANGUAGE MODE)
       ORDER BY ft_score DESC
       LIMIT ?`,
      [safeQuery, userId, sessionName || null, safeQuery, candidateLimit]
    );
  } catch (err) {
    console.warn("⚠️ FULLTEXT indisponível, fallback para LIMIT simples:", err);
    rows = await db.all<ChunkRow & { name?: string }>(
      `SELECT kc.id, kc.content, kc.embedding, kc.source_id, ks.name, kc.user_id
       FROM kb_chunks kc
       JOIN kb_sources ks ON ks.id = kc.source_id
       WHERE kc.user_id = ? AND ks.status = 'ready' AND (kc.session_scope IS NULL OR kc.session_scope = ?)
       ORDER BY kc.id DESC
       LIMIT ?`,
      [userId, sessionName || null, candidateLimit]
    );
  }

  const scored = rows
    .map((r) => {
      let emb: Record<string, number> = {};
      try {
        emb = typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding || {};
      } catch {
        emb = {};
      }
      const score = cosineSim(qVec, emb);
      return { content: r.content, sourceId: r.source_id, sourceName: r.name, score };
    })
    .filter((r) => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topK);

  await db.run(
    `INSERT INTO kb_queries (user_id, session_name, chat_id, query, latency_ms, result_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, sessionName || null, chatId || null, query, Date.now() - started, top.length, Date.now()]
  );

  return top;
}
