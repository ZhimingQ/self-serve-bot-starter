import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStore, type BillingPatch, type StoredUser } from "../../../../lib/store";
import { stripe as stripeConfig } from "../../../../lib/config";
import {
  checkoutMatchesOffer,
  invoiceMatchesOffer,
  isFundedInvoice,
  isFundedStorefrontCheckout,
  stripeReferenceId,
} from "../../../../lib/payment";

/**
 * Stripe webhook. Verifies the signature, then keeps each user's billingStatus
 * in sync with their payment/subscription:
 *   - checkout.session.completed / async_payment_succeeded → 'active' ONLY when
 *     Stripe actually collected a positive amount
 *   - invoice.paid                → 'active' only for a positive paid amount
 *   - checkout.session.async_payment_failed → 'canceled' (delayed pay never cleared)
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
    customerId?: string | null,
    // Ordering timestamp. Defaults to the event emission time, but checkout-session
    // events pass the SESSION's own created time so that a late-firing
    // async_payment_failed for an OLD session can't cancel a user who already paid
    // via a NEWER session — the older session's created time loses the guard.
    eventTime: number = event.created,
    identifiers: BillingPatch = {}
  ) {
    if (!userId) return;
    const user = await store.getUserById(userId);
    if (!user) return;
    if (user.lastBillingEventAt && eventTime < user.lastBillingEventAt) {
      console.log("[webhook] skipping stale event", event.id, "for", userId);
      return;
    }
    await store.setUserBilling(userId, {
      billingStatus,
      lastBillingEventAt: eventTime,
      ...identifiers,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    });
  }

  function customerIdOf(obj: { customer?: string | { id: string } | null }): string | undefined {
    return typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
  }

  function userOfferMatches(user: StoredUser | null): user is StoredUser {
    return Boolean(user &&
      user.stripePriceId === stripeConfig.priceId &&
      user.stripeBillingMode === stripeConfig.mode);
  }

  async function loadCheckout(sessionId: string) {
    return stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const eventSession = event.data.object as Stripe.Checkout.Session;
        const s = await loadCheckout(eventSession.id);
        // Do not grant a paid entitlement for a $0 checkout, coupon, or credit.
        // A delayed/async method must also wait until Stripe reports it paid.
        if (!isFundedStorefrontCheckout(s, stripeConfig.priceId, stripeConfig.mode)) break;
        const userId = s.client_reference_id || s.metadata?.appUserId;
        const user = userId ? await store.getUserById(userId) : null;
        if (!userOfferMatches(user) || user.stripeCheckoutSessionId !== s.id) break;
        await applyStatus(userId, "active", customerIdOf(s), s.created, {
          stripeCheckoutSessionId: s.id,
          stripePriceId: stripeConfig.priceId,
          stripeBillingMode: stripeConfig.mode,
          ...(stripeReferenceId(s.subscription) ? { stripeSubscriptionId: stripeReferenceId(s.subscription) } : {}),
          ...(stripeReferenceId(s.payment_intent) ? { stripePaymentIntentId: stripeReferenceId(s.payment_intent) } : {}),
        });
        break;
      }
      case "checkout.session.async_payment_failed": {
        // Delayed payment never cleared — make sure we don't leave them active.
        // Order by s.created so this can't cancel a user who paid via a later session.
        const eventSession = event.data.object as Stripe.Checkout.Session;
        const s = await loadCheckout(eventSession.id);
        const userId = s.client_reference_id || s.metadata?.appUserId;
        const user = userId ? await store.getUserById(userId) : null;
        if (!userOfferMatches(user) || user.stripeCheckoutSessionId !== s.id ||
          !checkoutMatchesOffer(s, stripeConfig.priceId, stripeConfig.mode)) break;
        await applyStatus(userId, "canceled", customerIdOf(s), s.created);
        break;
      }
      case "invoice.paid": {
        // Stripe also emits invoice.paid for $0 invoices. Those do not prove
        // that money was collected and must never grant a paid entitlement.
        const inv = event.data.object as Stripe.Invoice;
        if (stripeConfig.mode !== "subscription" || !isFundedInvoice(inv)) break;
        const cid = customerIdOf(inv);
        const user = cid ? await store.getUserByStripeCustomerId(cid) : null;
        if (!userOfferMatches(user) || !user.stripeSubscriptionId ||
          !invoiceMatchesOffer(inv, user.stripeSubscriptionId, stripeConfig.priceId)) break;
        await applyStatus(user?.id, "active", cid);
        break;
      }
      case "customer.subscription.deleted": {
        if (stripeConfig.mode !== "subscription") break;
        const subscription = event.data.object as Stripe.Subscription;
        const cid = customerIdOf(subscription);
        const user = cid ? await store.getUserByStripeCustomerId(cid) : null;
        if (!userOfferMatches(user) || user.stripeSubscriptionId !== subscription.id) break;
        await applyStatus(user?.id, "canceled", cid);
        break;
      }
      case "invoice.payment_failed": {
        if (stripeConfig.mode !== "subscription") break;
        const inv = event.data.object as Stripe.Invoice;
        const cid = customerIdOf(inv);
        const user = cid ? await store.getUserByStripeCustomerId(cid) : null;
        if (!userOfferMatches(user) || !user.stripeSubscriptionId ||
          !invoiceMatchesOffer(inv, user.stripeSubscriptionId, stripeConfig.priceId)) break;
        await applyStatus(user.id, "canceled", cid);
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
