import Stripe from "stripe";

const STRIPE_BRAND = {
  displayName: "ZapConnect",
  backgroundColor: "#0D1222",
  buttonColor: "#6C64EF",
  borderStyle: "rounded" as const,
  fontFamily: "inter" as const,
};

function normalizeBaseUrl() {
  const raw = process.env.APP_URL || process.env.BASE_URL || "";
  return raw.replace(/\/+$/, "");
}

export function getStripeCheckoutBranding(): Stripe.Checkout.SessionCreateParams.BrandingSettings | undefined {
  const baseUrl = normalizeBaseUrl();
  if (!baseUrl) return undefined;

  return {
    background_color: STRIPE_BRAND.backgroundColor,
    button_color: STRIPE_BRAND.buttonColor,
    border_style: STRIPE_BRAND.borderStyle,
    display_name: STRIPE_BRAND.displayName,
    font_family: STRIPE_BRAND.fontFamily,
    icon: {
      type: "url",
      url: `${baseUrl}/img/favinco.png`,
    },
    logo: {
      type: "url",
      url: `${baseUrl}/img/logo.png`,
    },
  };
}
