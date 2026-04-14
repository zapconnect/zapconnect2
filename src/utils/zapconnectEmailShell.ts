function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegExp(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractEmailBodyContent(html: string) {
  const raw = String(html || "").trim();
  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (bodyMatch ? bodyMatch[1] : raw).trim();
}

export function replaceEmailTemplateVariables(
  input: string,
  variables: Record<string, string>
) {
  let output = String(input || "");

  Object.entries(variables).forEach(([key, value]) => {
    const pattern = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, "g");
    output = output.replace(pattern, value);
  });

  return output;
}

type ZapconnectEmailShellOptions = {
  subtitle: string;
  greetingName: string;
  leadText: string;
  contentHtml: string;
  outroText?: string;
};

export function buildZapconnectEmailShell({
  subtitle,
  greetingName,
  leadText,
  contentHtml,
  outroText = "Se precisar de ajuda, basta responder este e-mail.",
}: ZapconnectEmailShellOptions) {
  const safeSubtitle = escapeHtml(subtitle);
  const safeGreetingName = escapeHtml(greetingName || "usuario");
  const safeLeadText = escapeHtml(leadText);
  const safeOutroText = escapeHtml(outroText);
  const normalizedContent = extractEmailBodyContent(contentHtml) || "<p>(vazio)</p>";
  const currentYear = new Date().getFullYear();

  return `
  <div style="background:#f6f7fb;padding:30px 0;font-family:Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">

      <div style="background:linear-gradient(135deg,#6C64EF,#4F46E5);padding:22px 26px;color:#fff;">
        <div style="font-size:18px;font-weight:700;letter-spacing:0.2px;">
          Zapconnect
        </div>
        <div style="font-size:13px;opacity:0.9;margin-top:4px;">
          ${safeSubtitle}
        </div>
      </div>

      <div style="padding:26px;">
        <h2 style="margin:0 0 12px 0;font-size:20px;color:#111827;">
          Ola, ${safeGreetingName} &#128075;
        </h2>

        <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.6;">
          ${safeLeadText}
        </p>

        <div style="font-size:14px;color:#374151;line-height:1.7;">
          ${normalizedContent}
        </div>

        <hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0;"/>

        <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">
          ${safeOutroText}
        </p>
      </div>

      <div style="background:#111827;padding:14px 20px;text-align:center;">
        <p style="margin:0;color:#9ca3af;font-size:12px;">
          &copy; ${currentYear} Zapconnect - Atendimento, Automacao e IA no WhatsApp.
        </p>
      </div>

    </div>
  </div>
  `;
}
