import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStore } from "../../../../lib/store";
import { stripe as stripeConfig } from "../../../../lib/config";

/**
 * Stripe webhook. Verifies the signature, then keeps each user's billingStatus
 * in sync with their payment/subscription:
 *   - checkout.session.completed  → 'active' (unlocks provisioning)
 *   - invoice.paid                → 'active' (subscription renewal)
 *   - customer.subscription.deleted / invoice.payment_failed → 'canceled'
 *
 * Point your Stripe webhook (or `stripe listen --forward-to`) at
 * /api/stripe/webhook and set STRIPE_WEBHOOK_SECRET to the signing secret.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfig.secretKey || !stripeConfig.webhookSecret) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 400 });
  }

  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = new Stripe(stripeConfig.secretKey);
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, stripeConfig.webhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "bad signature";
    console.error("[webhook] signature verification failed:", message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const store = getStore();

  // Apply a billing-status change ONLY if this event is newer than the last one
  // we applied for that user — so a replayed / out-of-order 'active' event can't
  // override a newer 'canceled' (or vice-versa). Also stamps stripeCustomerId.
  async function applyStatus(
    userId: string | null | undefined,
    billingStatus: "active" | "canceled",
    customerId?: string | null
  ) {
    if (!userId) return;
    const user = await store.getUserById(userId);
    if (!user) return;
    if (user.lastBillingEventAt && event.created < user.lastBillingEventAt) {
      console.log("[webhook] skipping stale event", event.id, "for", userId);
      return;
    }
    await store.setUserBilling(userId, {
      billingStatus,
      lastBillingEventAt: event.created,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    });
  }

  function customerIdOf(obj: { customer?: string | { id: string } | null }): string | undefined {
    return typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.client_reference_id || s.metadata?.appUserId;
        await applyStatus(userId, "active", customerIdOf(s));
        break;
      }
      case "invoice.paid": {
        // Subscription renewal — resolve the user by customer, re-affirm active.
        const inv = event.data.object as Stripe.Invoice;
        const cid = customerIdOf(inv);
        const user = cid ? await store.getUserByStripeCustomerId(cid) : null;
        await applyStatus(user?.id, "active", cid);
        break;
      }
      case "customer.subscription.deleted":
      case "invoice.payment_failed": {
        // Subscription lapsed / payment failed — revoke access.
        const cid = customerIdOf(event.data.object as { customer?: string | { id: string } });
        const user = cid ? await store.getUserByStripeCustomerId(cid) : null;
        await applyStatus(user?.id, "canceled", cid);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("[webhook] handler error:", err);
    // 500 so Stripe retries — a dropped activation must not silently strand a
    // paying customer without their bot.
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
