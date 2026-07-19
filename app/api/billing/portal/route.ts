import { NextResponse } from "next/server";
import Stripe from "stripe";
import { getSession } from "../../../../lib/session";
import { getStore } from "../../../../lib/store";
import { appUrl, paymentsEnabled, stripe as stripeConfig } from "../../../../lib/config";
import { rateLimit } from "../../../../lib/rateLimit";

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rl = await rateLimit("billing-portal", session.userId, 10, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  if (!paymentsEnabled || stripeConfig.mode !== "subscription") {
    return NextResponse.json({ error: "Billing management is not available" }, { status: 400 });
  }
  const user = await getStore().getUserById(session.userId);
  if (!user?.stripeCustomerId) return NextResponse.json({ error: "Billing customer not found" }, { status: 404 });
  try {
    const portal = await new Stripe(stripeConfig.secretKey).billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${appUrl}/app`,
    });
    return NextResponse.json({ url: portal.url });
  } catch (error) {
    console.error("[billing-portal] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not open billing management" }, { status: 502 });
  }
}
