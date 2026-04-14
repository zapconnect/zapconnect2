// src/utils/audit.ts
import { getDB } from "../database";

export async function logAudit(
  action: string,
  userId: number | null = null,
  entityType: string | null = null,
  entityId: string | number | null = null,
  meta: any = null
) {
  try {
    const db = getDB();
    await db.run(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        action,
        entityType,
        entityId === undefined ? null : String(entityId),
        meta === null || meta === undefined ? null : JSON.stringify(meta),
        Date.now(),
      ]
    );
  } catch (err) {
    // logging must never quebrar fluxo
    console.error("audit_log_failed", err);
  }
}
