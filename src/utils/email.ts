export function normalizeEmail(rawEmail: string): string {
  const email = String(rawEmail || "").trim().toLowerCase();
  const [localPart, domain] = email.split("@");

  if (!localPart || !domain) return email;

  const withoutAlias = localPart.split("+")[0];
  const domainsWithoutDots = new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "outlook.com.br",
    "hotmail.com",
    "hotmail.com.br",
    "live.com",
    "live.com.br",
    "msn.com",
  ]);

  const cleanedLocal = domainsWithoutDots.has(domain)
    ? withoutAlias.replace(/\./g, "")
    : withoutAlias;

  return `${cleanedLocal}@${domain}`;
}
