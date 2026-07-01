import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getStore } from "@/lib/store";
import { createInstance, getInstance } from "@/lib/buildResell";

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
