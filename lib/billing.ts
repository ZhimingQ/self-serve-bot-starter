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
 * Returns true iff the session belongs to this user AND funds are actually
 * collected — so a guessed session id for someone else's checkout can't activate
 * you, and a delayed/async payment method that is `complete` but still `unpaid`
 * can't unlock a bot before the money clears.
 */
export async function confirmCheckoutSession(userId: string, sessionId: string): Promise<boolean> {
  if (!stripeConfig.secretKey || !sessionId) return false;
  try {
    const stripe = new Stripe(stripeConfig.secretKey);
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    const owner = s.client_reference_id || s.metadata?.appUserId;
    if (owner !== userId) return false; // not this user's session
    // Fulfillment MUST key on payment_status, not `status: complete` — an async
    // method (bank debit, some wallets) can be `complete` while `unpaid`. Only
    // `paid` (funds collected) or `no_payment_required` ($0 / trial) entitle.
    const funded = s.payment_status === "paid" || s.payment_status === "no_payment_required";
    if (!funded) return false;
    // Ordering guard: an OLD paid session must not resurrect a subscription that a
    // NEWER cancel/payment-failed webhook already revoked. Reject any session
    // created before the last billing event we applied for this user.
    const store = getStore();
    const user = await store.getUserById(userId);
    if (user?.lastBillingEventAt && s.created < user.lastBillingEventAt) return false;
    const customerId = typeof s.customer === "string" ? s.customer : s.customer?.id;
    await store.setUserBilling(userId, {
      billingStatus: "active",
      lastBillingEventAt: s.created,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    });
    return true;
  } catch (err) {
    console.error("[billing] confirmCheckoutSession failed:", err);
    return false;
  }
}
