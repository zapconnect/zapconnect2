import express from "express";
import { stripe } from "../lib/stripe";
import { getStripeCheckoutBranding } from "../lib/stripeCheckoutBranding";

const router = express.Router();

router.post("/checkout", async (req, res) => {
  const { userId, email, priceId } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        user_id: String(userId),
      },
      success_url: `${process.env.APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/checkout/failure`,
      branding_settings: getStripeCheckoutBranding(),
      custom_text: {
        submit: {
          message: "Finalize sua assinatura com seguranca.",
        },
      },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: "Stripe error" });
  }
});

export default router;
