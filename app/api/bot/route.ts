import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { paymentsEnabled } from "../../../lib/config";
import { botLifecycle, getBotInfo } from "../../../lib/buildResell";
import { toBotView } from "../../../lib/botInfo";

// A restart waits for the container to come back.
export const maxDuration = 120;

/**
 * The customer's own assistant: what it is running and on what, and the one
 * control that fixes most trouble (restart), plus start when it is stopped.
 *
 * The instance id comes from the SESSION, never the browser, so a customer only
 * ever sees or restarts their own bot. The reply is lib/botInfo.ts's BotView:
 * no server, port, container or provider names.
 */

const noStore = { "Cache-Control": "private, no-store" };

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // The page polls every 30s per open tab, and the Usage card shares that poll.
  const rl = await rateLimit("bot-info", session.userId, 40, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: noStore });
  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409, headers: noStore });
  try {
    const result = await getBotInfo(instanceId);
    if (!result.ok) return NextResponse.json({ error: "upstream_error" }, { status: 502, headers: noStore });
    return NextResponse.json({ bot: toBotView((result.body as { data?: unknown }).data) }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502, headers: noStore });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = body?.action === "restart" || body?.action === "start" ? body.action : null;
  if (!action) return NextResponse.json({ error: "invalid_action" }, { status: 400 });

  const store = getStore();
  // Same gate as /api/provision: with payments on, only an active subscriber can
  // bring a bot back by starting or restarting it.
  if (paymentsEnabled) {
    const user = await store.getUserById(session.userId);
    if (user?.billingStatus !== "active") return NextResponse.json({ error: "plan_required" }, { status: 402 });
  }
  // Each one restarts the container.
  const rl = await rateLimit(`bot-${action}`, session.userId, 6, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const instanceId = await store.getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });

  try {
    const result = await botLifecycle(instanceId, action);
    if (result.status === 409) return NextResponse.json({ error: "invalid_state" }, { status: 409 });
    if (!result.ok) return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch {
    // Timed out waiting: the restart usually still completes; the page keeps polling.
    return NextResponse.json({ error: "timeout" }, { status: 504 });
  }
}
