import express from "express";
import { confirmEmailByToken } from "../services/emailVerification";

const router = express.Router();

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "");

    if (!token) {
      return res.render("emailVerifyResult", {
        ok: false,
        message: "Token inválido.",
      });
    }

    const result = await confirmEmailByToken(token);

    if (!result.ok) {
      const msg =
        result.error === "TOKEN_EXPIRED"
          ? "Esse link expirou. Solicite um novo."
          : "Token inválido ou já utilizado.";

      return res.render("emailVerifyResult", {
        ok: false,
        message: msg,
      });
    }

    return res.render("emailVerifyResult", {
      ok: true,
      message: "Seu e-mail foi confirmado com sucesso! ✅",
    });
  } catch (err) {
    console.error("Erro verify-email:", err);
    return res.render("emailVerifyResult", {
      ok: false,
      message: "Erro interno. Tente novamente.",
    });
  }
});

export default router;
