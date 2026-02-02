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
      return res.status(401).json({ error: "Não autenticado" });
    }

    const db = getDB();
    const user = await db.get(
      `SELECT * FROM users WHERE token = ?`,
      [token]
    );

    if (!user) {
      return res.status(401).json({ error: "Token inválido" });
    }

    (req as any).user = user;
    next();

  } catch (err) {
    console.error("❌ Erro authMiddleware:", err);
    res.status(500).json({ error: "Erro de autenticação" });
  }
}
