import crypto from "crypto";
import { getDB } from "../database";
import { sendEmail } from "./sendEmail";

export async function sendVerifyEmail(userId: number) {
  const db = getDB();

  const user = await db.get<any>(
    `SELECT id, name, email, email_verified FROM users WHERE id = ?`,
    [userId]
  );

  if (!user) throw new Error("Usuário não encontrado");

  if (Number(user.email_verified) === 1) {
    return { ok: true, alreadyVerified: true };
  }

  // 🔥 token
  const token = crypto.randomBytes(32).toString("hex");

  // 🔥 expira em 1 hora
  const expires = Date.now() + 1000 * 60 * 60;

  // salva no banco
  await db.run(
    `
    UPDATE users
    SET email_verify_token = ?, email_verify_expires = ?
    WHERE id = ?
    `,
    [token, expires, userId]
  );

  const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
  const link = `${BASE_URL}/verify-email?token=${token}`;

  const name = user.name || "usuário";

  const html = `
  <div style="background:#f6f7fb;padding:30px 0;font-family:Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">

      <div style="background:linear-gradient(135deg,#6C64EF,#4F46E5);padding:22px 26px;color:#fff;">
        <div style="font-size:18px;font-weight:700;letter-spacing:0.2px;">
          Zapconnect
        </div>
        <div style="font-size:13px;opacity:0.9;margin-top:4px;">
          Confirmação de e-mail
        </div>
      </div>

      <div style="padding:26px;">
        <h2 style="margin:0 0 12px 0;font-size:20px;color:#111827;">
          Olá, ${name} 👋
        </h2>

        <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.6;">
          Para liberar seu acesso ao <b>Zapconnect</b>, precisamos confirmar que este e-mail realmente pertence a você.
        </p>

        <div style="margin:22px 0;text-align:center;">
          <a href="${link}"
            style="
              background:#6C64EF;
              color:#ffffff;
              padding:14px 22px;
              border-radius:12px;
              text-decoration:none;
              font-weight:700;
              display:inline-block;
              font-size:14px;
            ">
            Confirmar meu e-mail
          </a>
        </div>

        <p style="margin:0 0 10px 0;font-size:13px;color:#6b7280;line-height:1.6;">
          Se o botão não funcionar, copie e cole este link no navegador:
        </p>

        <div style="
          background:#f3f4f6;
          padding:12px;
          border-radius:12px;
          font-size:12px;
          color:#111827;
          word-break:break-all;
          line-height:1.5;
        ">
          ${link}
        </div>

        <p style="margin:18px 0 0 0;font-size:12px;color:#9ca3af;">
          ⏳ Este link expira em 1 hora.
        </p>

        <hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0;"/>

        <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">
          Se você não criou uma conta no Zapconnect, pode ignorar este e-mail com segurança.
        </p>
      </div>

      <div style="background:#111827;padding:14px 20px;text-align:center;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">
          © ${new Date().getFullYear()} Zapconnect — Atendimento, Automação e IA no WhatsApp.
        </p>
      </div>

    </div>
  </div>
  `;

  await sendEmail(user.email, "🔐 Confirme seu e-mail para liberar o Zapconnect", html);

  return { ok: true };
}
