// src/utils/audit.ts
import { getDB } from "../database";

type AuditEntry = {
  userId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  meta: string | null;
  createdAt: number;
};

const AUDIT_BATCH_SIZE = Math.max(1, Number(process.env.AUDIT_BATCH_SIZE || 50));
const AUDIT_RETRY_DELAY_MS = Number(process.env.AUDIT_RETRY_DELAY_MS || 1000);
const auditQueue: AuditEntry[] = [];
let auditFlushScheduled = false;
let auditFlushInFlight = false;

function serializeAuditMeta(meta: any) {
  if (meta === null || meta === undefined) return null;

  try {
    return JSON.stringify(meta);
  } catch {
    return JSON.stringify({
      audit_meta_error: "unserializable_meta",
    });
  }
}

function scheduleAuditFlush(delayMs = 0) {
  if (auditFlushScheduled) return;

  auditFlushScheduled = true;

  const runner = () => {
    auditFlushScheduled = false;

    if (auditFlushInFlight || !auditQueue.length) {
      return;
    }

    void flushAuditQueue();
  };

  if (delayMs > 0) {
    const timer = setTimeout(runner, delayMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    return;
  }

  setImmediate(runner);
}

async function flushAuditQueue() {
  if (auditFlushInFlight || !auditQueue.length) {
    return;
  }

  auditFlushInFlight = true;
  let retryDelayMs = 0;

  const batch = auditQueue.splice(0, AUDIT_BATCH_SIZE);

  try {
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    const params = batch.flatMap((entry) => [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.meta,
      entry.createdAt,
    ]);

    const db = getDB();
    await db.run(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, meta, created_at)
       VALUES ${placeholders}`,
      params
    );
  } catch (err) {
    auditQueue.unshift(...batch);
    retryDelayMs = AUDIT_RETRY_DELAY_MS;
    console.error("audit_flush_failed", err);
  } finally {
    auditFlushInFlight = false;
  }

  if (auditQueue.length) {
    scheduleAuditFlush(retryDelayMs);
  }
}

export async function logAudit(
  action: string,
  userId: number | null = null,
  entityType: string | null = null,
  entityId: string | number | null = null,
  meta: any = null
) {
  auditQueue.push({
    userId,
    action,
    entityType,
    entityId: entityId === undefined || entityId === null ? null : String(entityId),
    meta: serializeAuditMeta(meta),
    createdAt: Date.now(),
  });

  scheduleAuditFlush();
}
