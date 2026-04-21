import express, { Request, Response } from "express";
import { PlanName } from "../config/plans";
import { stripe } from "../lib/stripe";
import { getStripeCheckoutBranding } from "../lib/stripeCheckoutBranding";
import { authMiddleware } from "../middlewares/authMiddleware";
import { getPlanConfig } from "../services/planConfigs";

const router = express.Router();

router.post(
  "/create",
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const { plan } = req.body as { plan: PlanName };

      if (!plan) {
        return res.status(400).json({ error: "Plano nao informado" });
      }

      const selectedPlan = await getPlanConfig(plan);

      if (!selectedPlan) {
        return res.status(400).json({ error: "Plano invalido" });
      }

      if (plan === "free" || selectedPlan.price === 0) {
        return res
          .status(400)
          .json({ error: "Plano free nao requer pagamento" });
      }

      const amountInCents = Math.round(selectedPlan.price * 100);
      const branding = getStripeCheckoutBranding();

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        customer_email: user.email,
        line_items: [
          {
            price_data: {
              currency: "brl",
              recurring: { interval: "month" },
              product_data: {
                name: `Plano ${selectedPlan.displayName}`,
              },
              unit_amount: amountInCents,
            },
            quantity: 1,
          },
        ],
        metadata: {
          user_id: String(user.id),
          plan,
        },
        success_url: `${process.env.APP_URL}/checkout/success`,
        cancel_url: `${process.env.APP_URL}/checkout`,
        branding_settings: branding,
        custom_text: {
          submit: {
            message: "Assine com seguranca pela ZapConnect.",
          },
        },
      });

      return res.json({ url: session.url });
    } catch (err) {
      console.error("Erro Stripe:", err);
      return res.status(500).json({ error: "Erro ao criar assinatura" });
    }
  }
);

export default router;
