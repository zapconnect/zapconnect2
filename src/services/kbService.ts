import axios from "axios";
import pdfParse from "pdf-parse";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import { getDB } from "../database";
import { withTimeout } from "../utils/withTimeout";

type KbSourceType = "text" | "url" | "file";
type LegacyVector = Record<string, number>;
type SemanticVector = number[];
type StoredEmbedding = LegacyVector | SemanticVector;

type ChunkRow = {
  id: number;
  content: string;
  embedding: any;
  source_id: number;
  user_id: number;
  name?: string;
  ft_score?: number | null;
  embedding_version?: number | null;
};

const DEFAULT_CHUNK_SIZE = 600;
const DEFAULT_OVERLAP = 120;
const MAX_CHUNKS_PER_SOURCE = 500;
const KB_EMBEDDING_VERSION = 2;
const KB_EMBEDDING_MODEL_ALIASES: Record<string, string> = {
  "text-embedding-004": "gemini-embedding-001",
  "embedding-001": "gemini-embedding-001",
  "embedding-gecko-001": "gemini-embedding-001",
};

function normalizeEmbeddingModelName(model: string | undefined | null) {
  const raw = String(model || "").trim();
  if (!raw) return "gemini-embedding-001";
  const normalized = raw.toLowerCase();
  return KB_EMBEDDING_MODEL_ALIASES[normalized] || raw;
}

const KB_EMBEDDING_MODEL = normalizeEmbeddingModelName(
  process.env.KB_EMBEDDING_MODEL
);
const KB_EMBED_TIMEOUT_MS = Number(process.env.KB_EMBED_TIMEOUT_MS || 25_000);
const KB_EMBED_BATCH_SIZE = Math.max(
  1,
  Number(process.env.KB_EMBED_BATCH_SIZE || 20)
);
const KB_SEMANTIC_SCAN_ALL_THRESHOLD = Math.max(
  100,
  Number(process.env.KB_SEMANTIC_SCAN_ALL_THRESHOLD || 1000)
);
const KB_PREFILTER_CANDIDATES = Math.max(
  80,
  Number(process.env.KB_PREFILTER_CANDIDATES || 120)
);
const KB_RECENT_CANDIDATES = Math.max(
  40,
  Number(process.env.KB_RECENT_CANDIDATES || 120)
);
const KB_UPGRADE_SOURCES_PER_QUERY = Math.max(
  1,
  Number(process.env.KB_UPGRADE_SOURCES_PER_QUERY || 6)
);

const embeddingClient = process.env.GEMINI_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_KEY)
  : null;
const embeddingModel = embeddingClient?.getGenerativeModel({
  model: KB_EMBEDDING_MODEL,
});
const sourceEmbeddingRefreshes = new Map<number, Promise<void>>();

function sanitizeText(raw: string): string {
  return String(raw || "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function stripHtml(html: string): string {
  return sanitizeText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function chunkText(
  text: string,
  size = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP
): string[] {
  const clean = sanitizeText(text);
  if (!clean) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_SOURCE) {
    const end = Math.min(clean.length, start + size);
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

function vectorizeLegacy(text: string): LegacyVector {
  const vec: LegacyVector = {};
  for (const token of tokenize(text)) {
    vec[token] = (vec[token] || 0) + 1;
  }
  return vec;
}

function cosineSimLegacy(a: LegacyVector, b: LegacyVector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (const [key, value] of Object.entries(a)) {
    if (b[key]) dot += value * b[key];
    na += value * value;
  }

  for (const value of Object.values(b)) {
    nb += value * value;
  }

  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function cosineSimSemantic(a: SemanticVector, b: SemanticVector): number {
  const size = Math.min(a.length, b.length);
  if (!size) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < size; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function detectTypeFromName(
  name: string
): KbSourceType | "pdf" | "txt" | "csv" | "unknown" {
  const ext = path.extname(String(name || "")).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".csv") return "csv";
  if ([".txt", ".md", ".json", ".xml", ".html", ".htm"].includes(ext)) {
    return "txt";
  }
  return "unknown";
}

function isProbablyUtf8TextBuffer(buffer: Buffer) {
  if (!buffer.length) return false;

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;

  for (const byte of sample) {
    if (byte === 0x00) return false;
    const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    const isPrintableAscii = byte >= 0x20 && byte <= 0x7e;
    const isHighByte = byte >= 0x80;
    if (!isAllowedControl && !isPrintableAscii && !isHighByte) {
      suspicious += 1;
    }
  }

  if (suspicious / sample.length > 0.1) return false;

  const decoded = sample.toString("utf-8");
  const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
  return replacementCount / Math.max(decoded.length, 1) <= 0.02;
}

async function extractTextFromBuffer(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const kind = detectTypeFromName(filename);
  if (kind === "pdf") {
    const data = await pdfParse(buffer);
    return data.text || "";
  }
  if (kind === "txt" || kind === "csv") {
    if (!isProbablyUtf8TextBuffer(buffer)) {
      throw new Error("Arquivo de texto invalido ou corrompido");
    }
    return buffer.toString("utf-8");
  }
  throw new Error("Tipo de arquivo nao suportado para a base de conhecimento");
}

function normalizeSemanticEmbedding(values: any): SemanticVector {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function parseStoredEmbedding(raw: any): StoredEmbedding | null {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    if (Array.isArray(parsed)) return normalizeSemanticEmbedding(parsed);
    return parsed as LegacyVector;
  } catch {
    return null;
  }
}

function getSemanticEmbedding(raw: any): SemanticVector {
  const parsed = parseStoredEmbedding(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function getLegacyEmbedding(raw: any): LegacyVector {
  const parsed = parseStoredEmbedding(raw);
  if (!parsed || Array.isArray(parsed)) return {};
  return parsed;
}

function buildEmbeddingContent(text: string) {
  return {
    role: "user",
    parts: [{ text }],
  };
}

async function generateQueryEmbedding(text: string): Promise<SemanticVector> {
  if (!embeddingModel) {
    throw new Error("Modelo de embeddings nao configurado");
  }

  const response = await withTimeout(
    embeddingModel.embedContent({
      content: buildEmbeddingContent(text),
      taskType: TaskType.RETRIEVAL_QUERY,
    }),
    KB_EMBED_TIMEOUT_MS,
    "KB embedContent query"
  );

  const values = normalizeSemanticEmbedding(response.embedding?.values || []);
  if (!values.length) {
    throw new Error("Resposta vazia de embeddings para a consulta");
  }
  return values;
}

async function generateDocumentEmbeddings(
  texts: string[],
  title?: string
): Promise<SemanticVector[]> {
  if (!embeddingModel) {
    throw new Error("Modelo de embeddings nao configurado");
  }

  const normalizedTitle = sanitizeText(title || "").slice(0, 120) || undefined;
  const output: SemanticVector[] = [];

  for (let index = 0; index < texts.length; index += KB_EMBED_BATCH_SIZE) {
    const slice = texts.slice(index, index + KB_EMBED_BATCH_SIZE);

    const response = await withTimeout(
      embeddingModel.batchEmbedContents({
        requests: slice.map((text) => ({
          content: buildEmbeddingContent(text),
          taskType: TaskType.RETRIEVAL_DOCUMENT,
          ...(normalizedTitle ? { title: normalizedTitle } : {}),
        })),
      }),
      KB_EMBED_TIMEOUT_MS,
      "KB batchEmbedContents"
    );

    const batchEmbeddings = Array.isArray(response.embeddings)
      ? response.embeddings.map((item) =>
          normalizeSemanticEmbedding(item?.values || [])
        )
      : [];

    if (batchEmbeddings.length !== slice.length) {
      throw new Error("Quantidade inesperada de embeddings retornada pelo Gemini");
    }

    for (const vector of batchEmbeddings) {
      if (!vector.length) {
        throw new Error("Embedding vazio retornado pelo Gemini");
      }
      output.push(vector);
    }
  }

  return output;
}

async function resolveEmbeddingsForChunks(chunks: string[], name: string) {
  try {
    const embeddings = await generateDocumentEmbeddings(chunks, name);
    return {
      embeddingVersion: KB_EMBEDDING_VERSION,
      embeddings,
    };
  } catch (err) {
    console.warn("Embeddings semanticos indisponiveis, fallback lexical:", err);
    return {
      embeddingVersion: 1,
      embeddings: chunks.map((chunk) => vectorizeLegacy(chunk)),
    };
  }
}

async function logKbQuery(
  userId: number,
  sessionName: string | undefined,
  chatId: string | undefined,
  query: string,
  startedAt: number,
  resultCount: number
) {
  const db = getDB();
  await db.run(
    `INSERT INTO kb_queries (user_id, session_name, chat_id, query, latency_ms, result_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      sessionName || null,
      chatId || null,
      query,
      Date.now() - startedAt,
      resultCount,
      Date.now(),
    ]
  );
}

async function countScopedChunks(userId: number, sessionName?: string | null) {
  const db = getDB();
  const row = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total
     FROM kb_chunks kc
     JOIN kb_sources ks ON ks.id = kc.source_id
     WHERE kc.user_id = ? AND ks.status = 'ready'
       AND (kc.session_scope IS NULL OR kc.session_scope = ?)`,
    [userId, sessionName || null]
  );
  return Number(row?.total || 0);
}

async function loadAllScopedChunkRows(
  userId: number,
  sessionName?: string | null
) {
  const db = getDB();
  return db.all<ChunkRow>(
    `SELECT kc.id, kc.content, kc.embedding, kc.source_id, kc.user_id, ks.name, ks.embedding_version
     FROM kb_chunks kc
     JOIN kb_sources ks ON ks.id = kc.source_id
     WHERE kc.user_id = ? AND ks.status = 'ready'
       AND (kc.session_scope IS NULL OR kc.session_scope = ?)
     ORDER BY kc.id DESC`,
    [userId, sessionName || null]
  );
}

async function loadHybridCandidateRows(
  userId: number,
  safeQuery: string,
  sessionName: string | null,
  limit: number
) {
  const db = getDB();
  const unique = new Map<number, ChunkRow>();

  try {
    const ftRows = await db.all<ChunkRow>(
      `SELECT kc.id, kc.content, kc.embedding, kc.source_id, kc.user_id, ks.name, ks.embedding_version,
              MATCH(kc.content) AGAINST (? IN NATURAL LANGUAGE MODE) AS ft_score
       FROM kb_chunks kc
       JOIN kb_sources ks ON ks.id = kc.source_id
       WHERE kc.user_id = ? AND ks.status = 'ready'
         AND (kc.session_scope IS NULL OR kc.session_scope = ?)
         AND MATCH(kc.content) AGAINST (? IN NATURAL LANGUAGE MODE)
       ORDER BY ft_score DESC
       LIMIT ?`,
      [safeQuery, userId, sessionName, safeQuery, limit]
    );

    for (const row of ftRows) {
      unique.set(row.id, row);
    }
  } catch (err) {
    console.warn("FULLTEXT indisponivel para KB, mantendo fallback recente:", err);
  }

  const recentRows = await db.all<ChunkRow>(
    `SELECT kc.id, kc.content, kc.embedding, kc.source_id, kc.user_id, ks.name, ks.embedding_version
     FROM kb_chunks kc
     JOIN kb_sources ks ON ks.id = kc.source_id
     WHERE kc.user_id = ? AND ks.status = 'ready'
       AND (kc.session_scope IS NULL OR kc.session_scope = ?)
     ORDER BY kc.id DESC
     LIMIT ?`,
    [userId, sessionName, Math.max(limit, KB_RECENT_CANDIDATES)]
  );

  for (const row of recentRows) {
    if (!unique.has(row.id)) {
      unique.set(row.id, row);
    }
  }

  return Array.from(unique.values());
}

async function reloadChunkRowsByIds(ids: number[]) {
  if (!ids.length) return [];
  const db = getDB();
  const placeholders = ids.map(() => "?").join(", ");
  return db.all<ChunkRow>(
    `SELECT kc.id, kc.content, kc.embedding, kc.source_id, kc.user_id, ks.name, ks.embedding_version
     FROM kb_chunks kc
     JOIN kb_sources ks ON ks.id = kc.source_id
     WHERE kc.id IN (${placeholders})`,
    ids
  );
}

async function ensureSemanticEmbeddingsForSource(sourceId: number) {
  if (!embeddingModel) return;

  const inFlight = sourceEmbeddingRefreshes.get(sourceId);
  if (inFlight) return inFlight;

  const upgradePromise = (async () => {
    const db = getDB();
    const source = await db.get<{
      id: number;
      name: string;
      embedding_version: number | null;
    }>(
      `SELECT id, name, embedding_version FROM kb_sources WHERE id = ? LIMIT 1`,
      [sourceId]
    );

    if (!source) return;
    if (Number(source.embedding_version || 0) >= KB_EMBEDDING_VERSION) return;

    const rows = await db.all<{ id: number; content: string }>(
      `SELECT id, content FROM kb_chunks WHERE source_id = ? ORDER BY chunk_index ASC`,
      [sourceId]
    );

    if (!rows.length) {
      await db.run(
        `UPDATE kb_sources SET embedding_version = ?, updated_at = ? WHERE id = ?`,
        [KB_EMBEDDING_VERSION, Date.now(), sourceId]
      );
      return;
    }

    const embeddings = await generateDocumentEmbeddings(
      rows.map((row) => row.content),
      source.name
    );

    for (let index = 0; index < rows.length; index++) {
      await db.run(`UPDATE kb_chunks SET embedding = ? WHERE id = ?`, [
        JSON.stringify(embeddings[index]),
        rows[index].id,
      ]);
    }

    await db.run(
      `UPDATE kb_sources
       SET embedding_version = ?, updated_at = ?, error = NULL
       WHERE id = ?`,
      [KB_EMBEDDING_VERSION, Date.now(), sourceId]
    );
  })()
    .catch((err) => {
      console.warn(`Nao foi possivel atualizar embeddings da fonte ${sourceId}:`, err);
    })
    .finally(() => {
      sourceEmbeddingRefreshes.delete(sourceId);
    });

  sourceEmbeddingRefreshes.set(sourceId, upgradePromise);
  return upgradePromise;
}

function scoreRows(
  rows: ChunkRow[],
  queryEmbedding: SemanticVector | null,
  legacyQueryVector: LegacyVector
) {
  return rows
    .map((row) => {
      const semanticEmbedding = getSemanticEmbedding(row.embedding);
      const semanticScore = queryEmbedding?.length
        ? cosineSimSemantic(queryEmbedding, semanticEmbedding)
        : 0;

      const legacyEmbedding = getLegacyEmbedding(row.embedding);
      const lexicalScore = Object.keys(legacyEmbedding).length
        ? cosineSimLegacy(legacyQueryVector, legacyEmbedding)
        : 0;

      const score = queryEmbedding?.length
        ? Math.max(semanticScore, lexicalScore * 0.85)
        : lexicalScore;

      return {
        content: row.content,
        sourceId: row.source_id,
        sourceName: row.name,
        score,
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
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
    `INSERT INTO kb_sources (user_id, type, name, source_url, status, embedding_version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'pending', 1, ?, ?)`,
    [userId, type, name, now, now]
  );
  const sourceId = source.insertId;

  const chunks = chunkText(content);
  const { embeddings, embeddingVersion } = await resolveEmbeddingsForChunks(
    chunks,
    name
  );

  let chunkCount = 0;
  let tokenCount = 0;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    tokenCount += tokenize(chunk).length;
    await db.run(
      `INSERT INTO kb_chunks (source_id, user_id, session_scope, chunk_index, content, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sourceId,
        userId,
        sessionScope,
        index,
        chunk,
        JSON.stringify(embeddings[index]),
        now,
      ]
    );
    chunkCount++;
  }

  await db.run(
    `UPDATE kb_sources
     SET status = 'ready', tokens = ?, chunks = ?, embedding_version = ?, updated_at = ?, error = NULL
     WHERE id = ?`,
    [tokenCount, chunkCount, embeddingVersion, now, sourceId]
  );

  return {
    sourceId,
    chunks: chunkCount,
    tokens: tokenCount,
    embeddingVersion,
  };
}

export async function ingestFileSource(params: {
  userId: number;
  filename: string;
  data: Buffer;
  sessionScope?: string | null;
}) {
  const { userId, filename, data, sessionScope = null } = params;
  let text = "";

  try {
    text = await extractTextFromBuffer(data, filename);
  } catch (err: any) {
    return { error: err?.message || "Falha ao extrair texto do arquivo" };
  }

  if (!text.trim()) {
    return { error: "Arquivo sem texto extraivel" };
  }

  const kbDir = path.join(process.cwd(), "kb_uploads", String(userId));
  fs.mkdirSync(kbDir, { recursive: true });
  const storedPath = path.join(kbDir, `${Date.now()}-${path.basename(filename)}`);
  fs.writeFileSync(storedPath, data);

  return ingestTextSource({
    userId,
    name: filename || "Arquivo",
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
    const res = await axios.get(url, { timeout: 10_000 });
    const text = stripHtml(res.data || "");
    if (!text) throw new Error("Conteudo vazio");
    return ingestTextSource({
      userId,
      name,
      content: text,
      sessionScope,
      type: "url",
    });
  } catch (err: any) {
    const db = getDB();
    const now = Date.now();
    const source = await db.run(
      `INSERT INTO kb_sources (user_id, type, name, source_url, status, error, embedding_version, created_at, updated_at)
       VALUES (?, 'url', ?, ?, 'error', ?, 1, ?, ?)`,
      [userId, name, url, String(err?.message || err || "erro"), now, now]
    );
    return { sourceId: source.insertId, error: true };
  }
}

export async function listSources(userId: number) {
  const db = getDB();
  return db.all(
    `SELECT id, type, name, source_url, status, error, embedding_version, tokens, chunks, created_at, updated_at
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
}): Promise<
  { content: string; sourceId: number; sourceName?: string; score: number }[]
> {
  const { userId, query, sessionName, chatId, topK = 5 } = params;
  const safeQuery = String(query || "").trim();
  if (!safeQuery) return [];

  const started = Date.now();
  const legacyQueryVector = vectorizeLegacy(safeQuery);
  let queryEmbedding: SemanticVector | null = null;

  try {
    queryEmbedding = await generateQueryEmbedding(safeQuery);
  } catch (err) {
    console.warn("Nao foi possivel gerar embedding da consulta KB:", err);
  }

  const totalScopedChunks = await countScopedChunks(userId, sessionName || null);
  if (!totalScopedChunks) {
    await logKbQuery(userId, sessionName, chatId, query, started, 0);
    return [];
  }

  const candidateLimit = Math.max(KB_PREFILTER_CANDIDATES, topK * 8);
  let rows = queryEmbedding?.length
    ? totalScopedChunks <= KB_SEMANTIC_SCAN_ALL_THRESHOLD
      ? await loadAllScopedChunkRows(userId, sessionName || null)
      : await loadHybridCandidateRows(
          userId,
          safeQuery,
          sessionName || null,
          candidateLimit
        )
    : await loadHybridCandidateRows(
        userId,
        safeQuery,
        sessionName || null,
        candidateLimit
      );

  if (queryEmbedding?.length && rows.length) {
    const staleSourceIds = Array.from(
      new Set(
        rows
          .filter(
            (row) =>
              Number(row.embedding_version || 0) < KB_EMBEDDING_VERSION ||
              !getSemanticEmbedding(row.embedding).length
          )
          .map((row) => row.source_id)
      )
    ).slice(0, KB_UPGRADE_SOURCES_PER_QUERY);

    if (staleSourceIds.length) {
      for (const sourceId of staleSourceIds) {
        await ensureSemanticEmbeddingsForSource(sourceId);
      }

      rows =
        totalScopedChunks <= KB_SEMANTIC_SCAN_ALL_THRESHOLD
          ? await loadAllScopedChunkRows(userId, sessionName || null)
          : await reloadChunkRowsByIds(rows.map((row) => row.id));
    }
  }

  const scored = scoreRows(rows, queryEmbedding, legacyQueryVector);
  const top = scored.slice(0, topK);

  await logKbQuery(userId, sessionName, chatId, query, started, top.length);
  return top;
}
