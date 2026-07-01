import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getStore } from "@/lib/store";
import { createInstance, getInstance } from "@/lib/buildResell";

/**
 * Idempotent: the first call creates the user's one-and-only bot instance;
 * every subsequent call just returns its current status (used for polling
 * while the freshly-created bot is spinning up, which takes ~30-90s).
 */
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const store = getStore();
  let instanceId = await store.getUserInstance(session.userId);

  if (!instanceId) {
    const instance = await createInstance();
    instanceId = instance.id;
    await store.setUserInstance(session.userId, instanceId);
    return NextResponse.json({ status: instance.status, instanceId });
  }

  const instance = await getInstance(instanceId);
  return NextResponse.json({
    status: instance?.status ?? "unknown",
    instanceId,
  });
}
