import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { deleteInstance } from "../../../lib/buildResell";
import { paymentsEnabled, stripe as stripeConfig } from "../../../lib/config";
import { rateLimit } from "../../../lib/rateLimit";
import { clearSession, getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";

/** Permanently delete the signed-in customer's storefront account. The order is
 *  deliberate: retire the bot, stop any Stripe billing, then remove local data.
 *  Each external step is retry-safe, and local data remains available if an
 *  upstream step fails so the customer can retry without becoming untraceable. */
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rl = await rateLimit("account-delete", session.userId, 3, 60 * 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  const body = (await request.json().catch(() => null)) as { confirmation?: unknown } | null;
  if (typeof body?.confirmation !== "string" || body.confirmation.trim().toLowerCase() !== session.email.toLowerCase()) {
    return NextResponse.json({ error: "confirmation_mismatch" }, { status: 400 });
  }

  const store = getStore();
  const user = await store.getUserById(session.userId);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  try {
    const instanceId = await store.getUserInstance(session.userId);
    if (instanceId) await deleteInstance(instanceId);

    if (paymentsEnabled && user.stripeCustomerId) {
      await new Stripe(stripeConfig.secretKey).customers.del(user.stripeCustomerId);
    }

    await store.deleteUserData(session.userId);
    await clearSession();
    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[account-delete] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not delete account" }, { status: 502 });
  }
}
