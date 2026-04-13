import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  // Gera token se não existir
  if (!req.cookies[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false, // precisa ser lido pelo JS para ser enviado no header
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 24 * 60 * 60 * 1000,
    });
    (req as any).csrfToken = token;
    return next();
  }

  // Métodos seguros não exigem validação
  if (SAFE_METHODS.has(req.method)) return next();

  // Webhooks (ex.: Stripe) ficam de fora
  if (req.path.startsWith("/webhook")) return next();

  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerToken = (req.headers[CSRF_HEADER] as string) || "";

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: "Requisição inválida (CSRF)" });
  }

  next();
}
