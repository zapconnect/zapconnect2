import { Request, Response, NextFunction } from "express";
import { getDB } from "../database";

const ALLOW_NOT_VERIFIED = [
  "/verify-email-required",
  "/auth/resend-verify-email",
  "/auth/logout",
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

    const db = getDB();

    const user = await db.get<any>(`SELECT * FROM users WHERE token = ?`, [
      token,
    ]);

    if (!user) {
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/login");
      }
      return res.status(401).json({ error: "Token inválido" });
    }

    // ✅ salva o user no req ANTES de qualquer bloqueio
    (req as any).user = user;

    // ✅ libera algumas rotas mesmo sem verificação
    if (ALLOW_NOT_VERIFIED.includes(req.path)) {
      return next();
    }

    const emailVerified = Number(user.email_verified) === 1;

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
