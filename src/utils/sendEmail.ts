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
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const info = await transporter.sendMail({
      from: `"Zapconnect" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });

    console.log("✅ Email enviado:", info.messageId);
  } catch (err) {
    console.error("❌ ERRO AO ENVIAR EMAIL:", err);
    throw err;
  }
}
