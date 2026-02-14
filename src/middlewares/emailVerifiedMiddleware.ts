import { Request, Response, NextFunction } from "express";

export function emailVerifiedMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user = (req as any).user;

  // se não tem user, authMiddleware não rodou
  if (!user) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  // já verificado? libera
  if (user.email_verified) return next();

  // ===========================
  // 🔥 SE FOR PÁGINA (HTML)
  // ===========================
  if (req.headers.accept?.includes("text/html")) {
    return res.redirect("/verify-email-required");
  }

  // ===========================
  // 🔥 SE FOR API (FETCH)
  // ===========================
  return res.status(403).json({
    error: "Confirme seu e-mail antes de acessar.",
    redirect: "/verify-email-required",
  });
}
