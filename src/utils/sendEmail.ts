import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Zapconnect <onboarding@resend.dev>";

  if (!apiKey) {
    console.error("❌ RESEND_API_KEY não configurada");
    throw new Error("RESEND_API_KEY não configurada");
  }

  console.log("📩 Enviando e-mail via Resend...");
  console.log("➡️ Para:", to);
  console.log("➡️ Assunto:", subject);

  try {
    const result = await resend.emails.send({
      from,
      to: [to],
      subject,
      html,
    });

    console.log("✅ Email enviado:", result?.data?.id || result);
    return result;

  } catch (err: any) {
    console.error("❌ ERRO AO ENVIAR EMAIL (RESEND):", err?.message || err);
    console.error(err);
    throw err;
  }
}
