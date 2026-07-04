import "server-only";
import Stripe from "stripe";
import { getStore } from "./store";
import { stripe as stripeConfig } from "./config";

/**
 * Verify a completed Stripe Checkout session on the success redirect and activate
 * the user immediately — the Stripe-recommended pattern. This does NOT depend on
 * the webhook, so:
 *   - activation is instant on return (no "paid but still paywalled" race), and
 *   - it works even if STRIPE_WEBHOOK_SECRET isn't configured (the webhook is then
 *     only needed for ongoing subscription lifecycle: renewals + cancellations).
 * Returns true iff the session belongs to this user AND is paid — so a guessed
 * session id for someone else's checkout can't activate you.
 */
export async function confirmCheckoutSession(userId: string, sessionId: string): Promise<boolean> {
  if (!stripeConfig.secretKey || !sessionId) return false;
  try {
    const stripe = new Stripe(stripeConfig.secretKey);
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    const owner = s.client_reference_id || s.metadata?.appUserId;
    if (owner !== userId) return false; // not this user's session
    const paid = s.payment_status === "paid" || s.status === "complete";
    if (!paid) return false;
    const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
    await getStore().setUserBilling(userId, {
      billingStatus: "active",
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    });
    return true;
  } catch (err) {
    console.error("[billing] confirmCheckoutSession failed:", err);
    return false;
  }
}
