// src/routes/stripe.ts
import express from "express";
import { stripe } from "../lib/stripe";

const router = express.Router();

router.post("/checkout", async (req, res) => {
  const { userId, email, priceId } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",

      customer_email: email,

      line_items: [
        {
          price: priceId, // price_XXXX criado no Stripe
          quantity: 1,
        },
      ],

      metadata: {
        user_id: String(userId),
      },

      success_url: `${process.env.APP_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/checkout/failure`,
    });

    res.json({ url: session.url });
  } catch (err: any) {
    console.error("❌ Stripe checkout error:", err.message);
    res.status(500).json({ error: "Stripe error" });
  }
});

export default router;
