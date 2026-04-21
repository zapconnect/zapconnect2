import { Request, Response, NextFunction } from "express";
import {
  clearAuthCookie,
  ensureFreshUserSession,
  findUserByToken,
  getTokenExpiresAt,
  isSessionExpired,
  setAuthCookie,
} from "../utils/authSession";

const ALLOW_NOT_VERIFIED = [
  "/verify-email-required",
  "/auth/resend-verify-email",
  "/auth/logout",
  "/auth/me",
];

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const token = req.cookies?.token;

    if (!token) {
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/login");
      }
      return res.status(401).json({ error: "Não autenticado" });
    }

    const user = await findUserByToken(token);

    if (!user) {
      clearAuthCookie(res);
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/login");
      }
      return res.status(401).json({ error: "Token inválido" });
    }

    if (isSessionExpired(user)) {
      clearAuthCookie(res);
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/login");
      }
      return res.status(401).json({ error: "Sessão expirada", redirect: "/login" });
    }

    let reqUser = user;

    try {
      const refreshed = await ensureFreshUserSession(user);
      const currentExpiry = getTokenExpiresAt(user);

      if (refreshed.token !== user.token || refreshed.expiresAt !== currentExpiry) {
        setAuthCookie(res, refreshed.token);
        reqUser = {
          ...user,
          token: refreshed.token,
          token_expires_at: refreshed.expiresAt,
        };
      }
    } catch (refreshErr) {
      console.error("Erro ao renovar sessão:", refreshErr);
    }

    (req as any).user = reqUser;

    if (ALLOW_NOT_VERIFIED.includes(req.path)) {
      return next();
    }

    const emailVerified = Number(reqUser.email_verified) === 1;

    if (!emailVerified) {
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/verify-email-required");
      }

      return res.status(403).json({
        error: "Confirme seu e-mail para acessar o sistema",
        redirect: "/verify-email-required",
      });
    }

    return next();
  } catch (err) {
    console.error("❌ Erro authMiddleware:", err);

    if (req.headers.accept?.includes("text/html")) {
      return res.redirect("/login");
    }

    return res.status(500).json({ error: "Erro de autenticação" });
  }
}
