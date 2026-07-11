import { NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { createInstance, getInstance } from "../../../lib/buildResell";
import { paymentsEnabled, demoMode } from "../../../lib/config";
import { rateLimit } from "../../../lib/rateLimit";

/**
 * Idempotent: the first call creates the user's one-and-only bot instance;
 * every subsequent call just returns its current status (used for polling
 * while the freshly-created bot is spinning up, which takes ~30-90s).
 *
 * Concurrent calls for the same user (e.g. a double-clicked signup) are
 * de-duped through `inflight` so they can't each create a separate bot. This
 * covers a single Node host (one process). On serverless with multiple
 * concurrent instances, add an idempotency key to createInstance() to be
 * fully race-proof.
 */
const inflight = new Map<string, Promise<{ status: string; instanceId: string }>>();

async function provision(userId: string): Promise<{ status: string; instanceId: string }> {
  const store = getStore();
  const existing = await store.getUserInstance(userId);
  if (existing) {
    const instance = await getInstance(existing);
    return { status: instance?.status ?? "unknown", instanceId: existing };
  }

  const instance = await createInstance();
  try {
    await store.setUserInstance(userId, instance.id);
  } catch (err) {
    // The bot was created but we couldn't persist the user->instance mapping.
    // Log the orphaned id for manual reconciliation and fail so the user can
    // retry rather than silently losing access to a bot they now "own".
    console.error(
      `[provision] created instance ${instance.id} for ${userId} but failed to persist the mapping:`,
      err
    );
    throw err;
  }
  return { status: instance.status, instanceId: instance.id };
}

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Per-user throttle. Generous (60/min) because the client polls this endpoint
  // every ~2s while the bot boots — real bot CREATION is already one-per-user
  // (idempotent) + payment-gated; this cap only stops pathological hammering.
  const rl = await rateLimit("provision", session.userId, 60, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  // Payment gate (server-side, authoritative): when Stripe is configured, only a
  // user whose billingStatus is 'active' may provision. This backs the paywall UI
  // so a crafted request can't get a free bot. NO-PAYMENT mode skips this.
  if (paymentsEnabled) {
    const user = await getStore().getUserById(session.userId);
    if (user?.billingStatus !== "active") {
      return NextResponse.json(
        { error: "payment_required", message: "Subscribe to activate your assistant." },
        { status: 402 }
      );
    }
  }

  // A public demo must never create a new billable bot. Existing users are
  // allowed through so login, status polling, and chat keep working.
  if (demoMode && !(await getStore().getUserInstance(session.userId))) {
    return NextResponse.json(
      { error: "demo_mode", message: "This is a live demo — new assistants are disabled." },
      { status: 403 }
    );
  }

  let pending = inflight.get(session.userId);
  if (!pending) {
    pending = provision(session.userId).finally(() => inflight.delete(session.userId));
    inflight.set(session.userId, pending);
  }

  try {
    return NextResponse.json(await pending);
  } catch {
    return NextResponse.json({ error: "Provisioning failed. Please try again." }, { status: 502 });
  }
}
