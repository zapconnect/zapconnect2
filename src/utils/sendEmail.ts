import nodemailer from "nodemailer";

export async function sendEmail(to: string, subject: string, html: string) {
  console.log("📩 Tentando enviar email para:", to);

  console.log("SMTP CONFIG:", {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS ? "OK" : "MISSING",
  });

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false, // true só se for 465
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },

      // 🔥 resolve muitos casos no Railway (IPv6 quebrado)
      family: 4,

      // 🔥 evita travar
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });

    // 🔥 valida config antes de enviar (bom pra debug)
    await transporter.verify();

    const info = await transporter.sendMail({
      from: `"Zapconnect" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });

    console.log("✅ Email enviado:", info.messageId);
    return { ok: true, messageId: info.messageId };

  } catch (err: any) {
    console.error("❌ ERRO AO ENVIAR EMAIL:", err?.message || err);

    // 🔥 log mais útil
    if (err?.code) console.error("CODE:", err.code);
    if (err?.command) console.error("COMMAND:", err.command);
    if (err?.response) console.error("RESPONSE:", err.response);

    throw err;
  }
}
