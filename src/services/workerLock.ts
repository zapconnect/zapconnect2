import crypto from "crypto";
import os from "os";
import { getDB } from "../database";

export const WORKER_INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

type WorkerLockRow = {
  lock_key: string;
  owner_id: string;
  expires_at: number;
};

async function readWorkerLock(lockKey: string) {
  const db = getDB();
  return db.get<WorkerLockRow>(
    `SELECT lock_key, owner_id, expires_at
     FROM worker_locks
     WHERE lock_key = ?`,
    [lockKey]
  );
}

export async function acquireWorkerLock(lockKey: string, ownerId: string, ttlMs: number) {
  const db = getDB();
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const updated = await db.run(
    `UPDATE worker_locks
     SET owner_id = ?, expires_at = ?, heartbeat_at = ?
     WHERE lock_key = ?
       AND (owner_id = ? OR expires_at <= ?)`,
    [ownerId, expiresAt, now, lockKey, ownerId, now]
  );

  if (!updated.affectedRows) {
    await db.run(
      `INSERT IGNORE INTO worker_locks (lock_key, owner_id, expires_at, heartbeat_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [lockKey, ownerId, expiresAt, now, now]
    );
  }

  const row = await readWorkerLock(lockKey);
  return row?.owner_id === ownerId && Number(row.expires_at) > now;
}

export async function renewWorkerLock(lockKey: string, ownerId: string, ttlMs: number) {
  const db = getDB();
  const now = Date.now();
  const expiresAt = now + ttlMs;

  const result = await db.run(
    `UPDATE worker_locks
     SET expires_at = ?, heartbeat_at = ?
     WHERE lock_key = ? AND owner_id = ?`,
    [expiresAt, now, lockKey, ownerId]
  );

  return result.affectedRows > 0;
}

export async function releaseWorkerLock(lockKey: string, ownerId: string) {
  const db = getDB();
  await db.run(
    `DELETE FROM worker_locks
     WHERE lock_key = ? AND owner_id = ?`,
    [lockKey, ownerId]
  );
}
