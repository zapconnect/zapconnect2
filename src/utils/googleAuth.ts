import crypto from "crypto";
import { CookieOptions } from "express";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_OAUTH_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_OAUTH_NONCE_COOKIE = "google_oauth_nonce";

const GOOGLE_OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

type GoogleTokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
};

type GoogleIdTokenClaims = {
  aud?: string | string[];
  exp?: number;
  iss?: string;
  nonce?: string;
};

export type GoogleOAuthProfile = {
  email: string;
  emailVerified: boolean;
  name: string;
  sub: string;
};

export class GoogleAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GoogleAuthError";
    this.code = code;
  }
}

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

export function isGoogleAuthConfigured() {
  return Boolean(
    String(process.env.GOOGLE_CLIENT_ID || "").trim() &&
      String(process.env.GOOGLE_CLIENT_SECRET || "").trim()
  );
}

export function getGoogleClientId() {
  return String(process.env.GOOGLE_CLIENT_ID || "").trim();
}

export function getGoogleClientSecret() {
  return String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
}

export function getGoogleRedirectUri(baseUrl: string) {
  const explicit = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
  return explicit || `${baseUrl}/auth/google/callback`;
}

export function getGoogleOAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: GOOGLE_OAUTH_COOKIE_MAX_AGE_MS,
  };
}

export function getGoogleOAuthCookieClearOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
  };
}

export function createGoogleOAuthState() {
  return crypto.randomBytes(24).toString("hex");
}

export function createGoogleOAuthNonce() {
  return crypto.randomBytes(24).toString("hex");
}

function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function decodeIdTokenClaims(idToken: string): GoogleIdTokenClaims {
  const parts = String(idToken || "").split(".");
  if (parts.length < 2) {
    throw new GoogleAuthError("google_invalid_id_token", "ID token inválido.");
  }

  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    throw new GoogleAuthError("google_invalid_id_token", "Não foi possível ler o ID token.");
  }
}

function validateIdTokenClaims(idToken: string, expectedNonce: string) {
  const claims = decodeIdTokenClaims(idToken);
  const clientId = getGoogleClientId();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const iss = String(claims.iss || "");
  const exp = Number(claims.exp || 0);

  if (!audiences.includes(clientId)) {
    throw new GoogleAuthError("google_invalid_audience", "Client ID do Google inválido.");
  }

  if (!["https://accounts.google.com", "accounts.google.com"].includes(iss)) {
    throw new GoogleAuthError("google_invalid_issuer", "Issuer do Google inválido.");
  }

  if (!exp || Date.now() >= exp * 1000) {
    throw new GoogleAuthError("google_id_token_expired", "ID token expirado.");
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new GoogleAuthError("google_invalid_nonce", "Nonce do Google inválido.");
  }
}

export function buildGoogleAuthUrl(baseUrl: string, state: string, nonce: string) {
  if (!isGoogleAuthConfigured()) {
    throw new GoogleAuthError("google_not_configured", "Google OAuth não configurado.");
  }

  const params = new URLSearchParams({
    client_id: getGoogleClientId(),
    redirect_uri: getGoogleRedirectUri(baseUrl),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  });

  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeGoogleCodeForProfile(
  baseUrl: string,
  code: string,
  expectedNonce: string
): Promise<GoogleOAuthProfile> {
  if (!isGoogleAuthConfigured()) {
    throw new GoogleAuthError("google_not_configured", "Google OAuth não configurado.");
  }

  const body = new URLSearchParams({
    code,
    client_id: getGoogleClientId(),
    client_secret: getGoogleClientSecret(),
    redirect_uri: getGoogleRedirectUri(baseUrl),
    grant_type: "authorization_code",
  });

  const tokenResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!tokenResponse.ok) {
    throw new GoogleAuthError("google_token_exchange_failed", "Falha ao trocar o código do Google.");
  }

  const tokenPayload = (await tokenResponse.json()) as GoogleTokenResponse;
  if (!tokenPayload.access_token) {
    throw new GoogleAuthError("google_missing_access_token", "Google não retornou access token.");
  }

  if (tokenPayload.id_token) {
    validateIdTokenClaims(tokenPayload.id_token, expectedNonce);
  }

  const profileResponse = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
    },
  });

  if (!profileResponse.ok) {
    throw new GoogleAuthError("google_profile_fetch_failed", "Falha ao buscar perfil do Google.");
  }

  const profilePayload = (await profileResponse.json()) as Record<string, unknown>;
  const email = String(profilePayload.email || "").trim().toLowerCase();
  const sub = String(profilePayload.sub || "").trim();
  const name = String(profilePayload.name || "").trim();
  const emailVerified =
    profilePayload.email_verified === true || String(profilePayload.email_verified || "") === "true";

  if (!email || !sub) {
    throw new GoogleAuthError("google_incomplete_profile", "Perfil do Google incompleto.");
  }

  return {
    email,
    emailVerified,
    name: name || email.split("@")[0],
    sub,
  };
}
