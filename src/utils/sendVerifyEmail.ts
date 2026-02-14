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

  // Se já está verificado, não envia
  if (Number(user.email_verified) === 1) {
    return { ok: true, alreadyVerified: true };
  }

  // 🔥 token seguro
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

  const safeName = user.name ? String(user.name).trim() : "usuário";

  // ✅ HTML SaaS Zapconnect
  const html = `
  <!DOCTYPE html>
  <html lang="pt-br">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Confirme seu e-mail - Zapconnect</title>
    </head>

    <body style="margin:0; padding:0; background:#0D1222; font-family: Inter, Arial, sans-serif;">

      <!-- Fundo -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0D1222; padding: 40px 14px;">
        <tr>
          <td align="center">

            <!-- Container -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
              style="
                max-width: 620px;
                background: #161B30;
                border: 1px solid #373E59;
                border-radius: 18px;
                overflow:hidden;
              ">

              <!-- Topo -->
              <tr>
                <td style="padding: 22px 26px; background: rgba(22,27,48,0.95); border-bottom: 1px solid #373E59;">
                  <div style="display:flex; align-items:center; gap:12px;">
                    <div style="width: 12px; height: 12px; border-radius: 999px; background: #6C64EF;"></div>
                    <div style="color:#fff; font-size: 16px; font-weight: 800; letter-spacing: .2px;">
                      Zapconnect
                    </div>
                  </div>
                </td>
              </tr>

              <!-- Corpo -->
              <tr>
                <td style="padding: 28px 26px; color: #fff;">

                  <h1 style="margin:0 0 10px 0; font-size: 22px; font-weight: 900;">
                    📩 Confirme seu e-mail
                  </h1>

                  <p style="margin:0 0 18px 0; color:#AAB0D9; font-size: 15px; line-height: 1.7;">
                    Olá <b style="color:#fff;">${safeName}</b> 👋
                    <br />
                    Para liberar seu acesso ao <b>Zapconnect</b>, confirme seu e-mail clicando no botão abaixo.
                  </p>

                  <!-- Botão -->
                  <div style="margin: 22px 0 22px 0;">
                    <a href="${link}"
                      style="
                        display:inline-block;
                        padding: 14px 18px;
                        border-radius: 14px;
                        background: linear-gradient(135deg, #6C64EF, #8B5CF6);
                        color: #ffffff;
                        text-decoration: none;
                        font-weight: 900;
                        font-size: 15px;
                        letter-spacing: .2px;
                      ">
                      Confirmar e-mail
                    </a>
                  </div>

                  <!-- Link alternativo -->
                  <div style="
                    background: #1A1F3A;
                    border: 1px solid #373E59;
                    border-radius: 14px;
                    padding: 14px 14px;
                    margin: 10px 0 20px 0;
                  ">
                    <p style="margin:0 0 8px 0; color:#AAB0D9; font-size: 13px;">
                      Se o botão não funcionar, copie e cole este link no navegador:
                    </p>

                    <p style="
                      margin:0;
                      font-size: 13px;
                      word-break: break-all;
                      color: #ffffff;
                      line-height: 1.6;
                    ">
                      ${link}
                    </p>
                  </div>

                  <!-- Avisos -->
                  <div style="
                    background: linear-gradient(135deg, #2a1020, #3b1425);
                    border: 1px solid #E54848;
                    border-radius: 14px;
                    padding: 14px 14px;
                  ">
                    <p style="margin:0; color:#fff; font-size: 13px; line-height: 1.7;">
                      ⏳ <b>Importante:</b> este link expira em <b>1 hora</b>.
                      <br />
                      Se você não solicitou este cadastro, pode ignorar este e-mail.
                    </p>
                  </div>

                  <div style="height: 18px;"></div>

                  <p style="margin:0; color:#AAB0D9; font-size: 13px; line-height: 1.7;">
                    Até já 🚀
                    <br />
                    <b style="color:#fff;">Equipe Zapconnect</b>
                  </p>

                </td>
              </tr>

              <!-- Rodapé -->
              <tr>
                <td style="padding: 18px 26px; border-top: 1px solid #373E59; background: #12172e;">
                  <p style="margin:0; color:#AAB0D9; font-size: 12px; line-height: 1.7;">
                    Este e-mail foi enviado automaticamente pelo Zapconnect.
                    <br />
                    Se precisar de ajuda, responda este e-mail ou fale com o suporte.
                  </p>
                </td>
              </tr>

            </table>

          </td>
        </tr>
      </table>

    </body>
  </html>
  `;

  await sendEmail(user.email, "Confirme seu e-mail - Zapconnect", html);

  return { ok: true };
}
