import crypto from "crypto";
import { getDB } from "../database";

export async function generateEmailVerification(userId: number) {
  const db = await getDB();

  const token = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + 1000 * 60 * 60 * 24; // 24h

  await db.run(
    `UPDATE users
     SET email_verify_token = ?, email_verify_expires = ?, email_verified = 0
     WHERE id = ?`,
    [token, expires, userId]
  );

  return { token, expires };
}
export async function confirmEmailByToken(token: string) {
  const db = await getDB();

  const user = await db.get<{
    id: number;
    email_verify_expires: number;
  }>(
    `SELECT id, email_verify_expires
     FROM users
     WHERE email_verify_token = ?`,
    [token]
  );

  if (!user) {
    return { ok: false, error: "TOKEN_INVALID" };
  }

  if (!user.email_verify_expires || Date.now() > Number(user.email_verify_expires)) {
    return { ok: false, error: "TOKEN_EXPIRED" };
  }

  await db.run(
    `UPDATE users
     SET email_verified = 1,
         email_verify_token = NULL,
         email_verify_expires = NULL
     WHERE id = ?`,
    [user.id]
  );

  return { ok: true };
}
