import { Request, Response, NextFunction } from "express";
import { getDB } from "../database";

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

    const user = await db.get<any>(
      `SELECT * FROM users WHERE token = ?`,
      [token]
    );

    if (!user) {
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/login");
      }
      return res.status(401).json({ error: "Token inválido" });
    }

    // ✅ deixa passar a rota de aviso SEM LOOP
    if (req.path === "/verify-email-required") {
      return next();
    }


    // 🔥 CORRETO: garante boolean real
    const emailVerified = Number(user.email_verified) === 1;

    // 🔒 BLOQUEAR SE EMAIL NÃO VERIFICADO
    if (!emailVerified) {
      if (req.headers.accept?.includes("text/html")) {
        return res.redirect("/verify-email-required");
      }

      return res.status(403).json({
        error: "Confirme seu e-mail para acessar o sistema",
      });
    }

    (req as any).user = user;
    next();
  } catch (err) {
    console.error("❌ Erro authMiddleware:", err);

    if (req.headers.accept?.includes("text/html")) {
      return res.redirect("/login");
    }

    return res.status(500).json({ error: "Erro de autenticação" });
  }
}
