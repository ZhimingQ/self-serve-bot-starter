import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "../../../../lib/session";
import { getStore } from "../../../../lib/store";
import { rateLimit } from "../../../../lib/rateLimit";
import { botToolEnabled, enabledBotTools } from "../../../../lib/config";
import { BOT_TOOL_ACTIONS, type Method } from "../../../../lib/botToolsHandlers";

/**
 * /api/bot-tools/{action} — the "Bot tools" panel's only door to the platform.
 *
 * Same hard scoping as /api/model-key and /api/channels, applied once here for
 * every action:
 *
 *   1. `action` must be a key of BOT_TOOL_ACTIONS with a handler for this HTTP
 *      method. There is no generic passthrough: the table in
 *      lib/botToolsHandlers.ts is the complete list of what a customer can do,
 *      and each entry maps to exactly one platform call.
 *   2. The tool it belongs to must be enabled in BOT_TOOLS. A disabled tool is a
 *      404 — the same answer as an action that does not exist — so a customer
 *      cannot learn that a tool they were never offered exists.
 *   3. The instance id comes from the SESSION (via the store), never from the
 *      request. All bots sit behind the same reseller key, so accepting an id
 *      from the browser would let any customer act on every other customer's bot.
 *   4. Every action carries a per-customer rate limit.
 *
 * The reseller's sk_live_ key never leaves the server: lib/buildResell is
 * import-guarded ("server-only").
 */

export const dynamic = "force-dynamic";
// Restoring a backup restarts the assistant and waits for it to come back
// healthy; give the slowest action room on hosts that honour this.
export const maxDuration = 300;

const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

async function dispatch(method: Method, request: NextRequest, params: Promise<{ action: string }>): Promise<Response> {
  const { action } = await params;
  const spec = Object.prototype.hasOwnProperty.call(BOT_TOOL_ACTIONS, action) ? BOT_TOOL_ACTIONS[action][method] : undefined;
  if (!spec) return notFound();
  if (spec.tool ? !botToolEnabled(spec.tool) : enabledBotTools.length === 0) return notFound();

  // Only this storefront's own pages may drive these. The session cookie is
  // SameSite=Lax, which already keeps it off cross-site POSTs; this also covers
  // the two GET downloads, which a link on another site could otherwise start
  // (and so spend the customer's backup allowance). Current browsers send the
  // header; an older one without it falls back to SameSite alone.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  if (spec.limit) {
    const rl = await rateLimit(`bot-tools-${action}-${method.toLowerCase()}`, session.userId, spec.limit.max, spec.limit.windowSec);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }
  }

  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });

  try {
    return await spec.run({ request, userId: session.userId, instanceId });
  } catch (err) {
    console.error(`[bot-tools] ${method} ${action} failed:`, err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

type RouteContext = { params: Promise<{ action: string }> };

export function GET(request: NextRequest, { params }: RouteContext) {
  return dispatch("GET", request, params);
}
export function POST(request: NextRequest, { params }: RouteContext) {
  return dispatch("POST", request, params);
}
export function PUT(request: NextRequest, { params }: RouteContext) {
  return dispatch("PUT", request, params);
}
export function DELETE(request: NextRequest, { params }: RouteContext) {
  return dispatch("DELETE", request, params);
}
