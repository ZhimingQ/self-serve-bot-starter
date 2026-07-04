import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { stripe as stripeConfig, paymentsEnabled, appUrl } from "../../../lib/config";

/**
 * Start a Stripe Checkout for the signed-in end user. Returns { url } to redirect
 * the browser to. On completion Stripe redirects back to /app?paid=1 and fires
 * checkout.session.completed → /api/stripe/webhook marks the user 'active', which
 * unlocks provisioning. Charged on YOUR Stripe account — your markup is yours.
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!paymentsEnabled) {
    // Stripe not configured — provisioning is not gated; the client shouldn't
    // reach here, but fail loudly rather than silently.
    return NextResponse.json({ error: "Payments are not configured." }, { status: 400 });
  }

  const store = getStore();
  const user = await store.getUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (user.billingStatus === "active") {
    return NextResponse.json({ alreadyPaid: true });
  }

  const stripe = new Stripe(stripeConfig.secretKey);

  try {
    // Reuse the user's Stripe customer if we've created one before (keeps their
    // payment history + subscription under one customer).
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { appUserId: user.id },
      });
      customerId = customer.id;
      await store.setUserBilling(user.id, { stripeCustomerId: customerId });
    }

    const checkout = await stripe.checkout.sessions.create({
      mode: stripeConfig.mode,
      customer: customerId,
      line_items: [{ price: stripeConfig.priceId, quantity: 1 }],
      // client_reference_id + metadata both carry our user id so the webhook can
      // resolve the payer regardless of which field it reads.
      client_reference_id: user.id,
      metadata: { appUserId: user.id },
      // {CHECKOUT_SESSION_ID} is substituted by Stripe — /app verifies it server-
      // side and activates immediately (no dependency on webhook timing).
      success_url: `${appUrl}/app?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/app?checkout=cancel`,
    });

    if (!checkout.url) {
      return NextResponse.json({ error: "Could not start checkout." }, { status: 502 });
    }
    return NextResponse.json({ url: checkout.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    console.error("[checkout] failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
