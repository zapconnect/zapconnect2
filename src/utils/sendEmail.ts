// src/utils/sendEmail.ts
import nodemailer from "nodemailer";

export async function sendEmail(to: string, subject: string, html: string) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.error("❌ SMTP não configurado corretamente no .env");
    throw new Error("SMTP não configurado corretamente");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true se 465
    auth: { user, pass },
  });

  console.log("📩 Enviando e-mail via Gmail SMTP...");
  console.log("➡️ Para:", to);
  console.log("➡️ Assunto:", subject);

  try {
    const info = await transporter.sendMail({
      from: `"Zapconnect" <${user}>`,
      to,
      subject,
      html,
    });

    console.log("✅ Email enviado:", info.messageId);
    return info;

  } catch (err: any) {
    console.error("❌ ERRO AO ENVIAR EMAIL (GMAIL SMTP):", err?.message || err);
    console.error(err);
    throw err;
  }
}
