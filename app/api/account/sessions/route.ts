import { NextResponse } from "next/server";
import { getSession, setSession } from "../../../../lib/session";
import { getStore } from "../../../../lib/store";
import { rateLimit } from "../../../../lib/rateLimit";

/** Revoke every previously issued browser session while keeping this one active. */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rl = await rateLimit("session-revoke", session.userId, 5, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  try {
    const store = getStore();
    const sessionVersion = await store.rotateUserSessionVersion(session.userId);
    await setSession(
      { userId: session.userId, email: session.email },
      { sessionVersion, iat: session.iat }
    );
  } catch (error) {
    console.error("[session-revoke] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "session_revoke_failed" }, { status: 503 });
  }

  return NextResponse.json({ revoked: true });
}
