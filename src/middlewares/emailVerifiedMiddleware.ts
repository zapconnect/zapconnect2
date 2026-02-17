import { Request, Response, NextFunction } from "express";

export function emailVerifiedMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user = (req as any).user;

  if (!user) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  // garante boolean real
  const emailVerified = Number(user.email_verified) === 1;

  if (emailVerified) return next();

  // HTML
  if (req.headers.accept?.includes("text/html")) {
    return res.redirect("/verify-email-required");
  }

  // API
  return res.status(403).json({
    error: "Confirme seu e-mail antes de acessar.",
    redirect: "/verify-email-required",
  });
}
