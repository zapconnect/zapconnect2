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

  const name = user.name?.trim() || "usuário";

  const year = new Date().getFullYear();

  // Preheader (aparece no Gmail)
  const preheader =
    "Confirme seu e-mail para liberar seu acesso ao Zapconnect.";

  const html = `
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${preheader}
  </div>

  <div style="background:#f6f7fb;padding:34px 0;font-family:Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:0 14px;">
      <div style="background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 10px 35px rgba(0,0,0,0.08);">

        <!-- Header -->
        <div style="background:linear-gradient(135deg,#6C64EF,#4F46E5);padding:26px 28px;color:#fff;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="
              width:40px;height:40px;border-radius:12px;
              background:rgba(255,255,255,0.18);
              display:flex;align-items:center;justify-content:center;
              font-weight:900;font-size:18px;
            ">
              Z
            </div>

            <div>
              <div style="font-size:18px;font-weight:800;letter-spacing:0.2px;">
                Zapconnect
              </div>
              <div style="font-size:13px;opacity:0.92;margin-top:2px;">
                Confirmação de e-mail
              </div>
            </div>
          </div>
        </div>

        <!-- Body -->
        <div style="padding:28px;">
          <h2 style="margin:0 0 10px 0;font-size:20px;color:#111827;">
            Olá, ${name} 👋
          </h2>

          <p style="margin:0 0 18px 0;font-size:14px;color:#374151;line-height:1.7;">
            Você está a 1 passo de liberar seu acesso ao <b>Zapconnect</b>.
            Para confirmar sua conta, clique no botão abaixo:
          </p>

          <!-- CTA -->
          <div style="margin:22px 0;text-align:center;">
            <a href="${link}"
              style="
                background:#6C64EF;
                color:#ffffff;
                padding:14px 22px;
                border-radius:14px;
                text-decoration:none;
                font-weight:800;
                display:inline-block;
                font-size:14px;
                box-shadow:0 10px 18px rgba(108,100,239,0.28);
              ">
              Confirmar meu e-mail
            </a>
          </div>

          <div style="
            background:#F9FAFB;
            border:1px solid #E5E7EB;
            padding:14px;
            border-radius:14px;
            margin:18px 0 0 0;
          ">
            <p style="margin:0 0 10px 0;font-size:13px;color:#6b7280;line-height:1.6;">
              Se o botão não funcionar, copie e cole este link no navegador:
            </p>

            <div style="
              background:#ffffff;
              padding:12px;
              border-radius:12px;
              font-size:12px;
              color:#111827;
              word-break:break-all;
              line-height:1.5;
              border:1px solid #E5E7EB;
            ">
              ${link}
            </div>

            <p style="margin:12px 0 0 0;font-size:12px;color:#9ca3af;">
              ⏳ Este link expira em 1 hora.
            </p>
          </div>

          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>

          <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
            Se você não criou uma conta no Zapconnect, ignore este e-mail com segurança.
          </p>
        </div>

        <!-- Footer -->
        <div style="background:#0B1220;padding:16px 22px;text-align:center;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.5;">
            © ${year} Zapconnect — Atendimento, Automação e IA no WhatsApp.
          </p>
        </div>

      </div>
    </div>
  </div>
  `;

  await sendEmail(
    user.email,
    "🔐 Confirme seu e-mail para liberar o Zapconnect",
    html
  );

  return { ok: true };
}
