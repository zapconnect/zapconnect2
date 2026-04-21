import crypto from "crypto";
import { CookieOptions, Response } from "express";
import { getDB } from "../database";
import { User } from "../database/types";

export type AuthenticatedUser = User & {
  email_verified?: number;
  token_expires_at?: number | null;
};

export const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

export function createSessionToken(now = Date.now()) {
  return {
    token: crypto.randomBytes(20).toString("hex"),
    expiresAt: now + TOKEN_MAX_AGE_MS,
  };
}

export function getAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: TOKEN_MAX_AGE_MS,
  };
}

export function getAuthCookieClearOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
  };
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie("token", token, getAuthCookieOptions());
}

export function clearAuthCookie(res: Response) {
  res.clearCookie("token", getAuthCookieClearOptions());
}

export function getTokenExpiresAt(
  user: Pick<AuthenticatedUser, "token_expires_at">
): number | null {
  const expiresAt = Number(user.token_expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }
  return expiresAt;
}

export function isSessionExpired(
  user: Pick<AuthenticatedUser, "token_expires_at">,
  now = Date.now()
) {
  const expiresAt = getTokenExpiresAt(user);
  return expiresAt !== null && now > expiresAt;
}

export function shouldRefreshSession(
  user: Pick<AuthenticatedUser, "token_expires_at">,
  now = Date.now()
) {
  const expiresAt = getTokenExpiresAt(user);
  return expiresAt === null || expiresAt - now <= TOKEN_RENEW_THRESHOLD_MS;
}

export async function findUserByToken(token: string): Promise<AuthenticatedUser | null> {
  const db = getDB();
  return db.get<AuthenticatedUser>("SELECT * FROM users WHERE token = ?", [token]);
}

export async function issueUserSession(userId: number, now = Date.now()) {
  const session = createSessionToken(now);
  const db = getDB();

  await db.run(
    `UPDATE users SET token = ?, token_expires_at = ? WHERE id = ?`,
    [session.token, session.expiresAt, userId]
  );

  return session;
}

async function backfillUserSessionExpiry(
  userId: number,
  token: string,
  now = Date.now()
) {
  const expiresAt = now + TOKEN_MAX_AGE_MS;
  const db = getDB();

  await db.run(
    `UPDATE users SET token_expires_at = ? WHERE id = ? AND token = ?`,
    [expiresAt, userId, token]
  );

  return {
    token,
    expiresAt,
  };
}

async function extendUserSessionExpiry(
  userId: number,
  token: string,
  now = Date.now()
) {
  const expiresAt = now + TOKEN_MAX_AGE_MS;
  const db = getDB();

  await db.run(
    `UPDATE users SET token_expires_at = ? WHERE id = ? AND token = ?`,
    [expiresAt, userId, token]
  );

  return {
    token,
    expiresAt,
  };
}

export async function ensureFreshUserSession(
  user: Pick<AuthenticatedUser, "id" | "token" | "token_expires_at">,
  now = Date.now()
) {
  const currentExpiry = getTokenExpiresAt(user);

  if (!shouldRefreshSession(user, now) && currentExpiry !== null) {
    return {
      token: user.token,
      expiresAt: currentExpiry,
      rotated: false,
    };
  }

  if (currentExpiry === null) {
    const session = await backfillUserSessionExpiry(user.id, user.token, now);
    return {
      ...session,
      rotated: false,
    };
  }

  const session = await extendUserSessionExpiry(user.id, user.token, now);
  return {
    ...session,
    rotated: false,
  };
}

export async function invalidateUserSession(userId: number) {
  const db = getDB();
  const { token } = createSessionToken();

  await db.run(
    `UPDATE users SET token = ?, token_expires_at = NULL WHERE id = ?`,
    [token, userId]
  );

  return token;
}
