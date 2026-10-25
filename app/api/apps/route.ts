import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { allowAppConnect, paymentsEnabled } from "../../../lib/config";
import { connectApp, disconnectApp, getApps } from "../../../lib/buildResell";

/**
 * Connected apps — Gmail, Google Calendar, Notion and the rest.
 *
 * Same hard scoping as the channels route: the instance id comes from the
 * SESSION, so a customer only ever sees and changes their own bot's apps, and
 * the reseller's sk_live_ key stays on the server. The platform keeps each
 * bot's connections in that bot's own pool, the same one the bot uses when it
 * connects an app from chat, so this page and the chat always agree.
 *
 * Connecting needs an active plan when payments are on (it opens a capability);
 * listing and disconnecting do not — a paused customer must always be able to
 * remove access. ALLOW_APP_CONNECT=0 hides the panel and turns this route off.
 */

const SLUG_RE = /^[a-z0-9_-]{1,64}$/;
const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const NO_STORE = { "Cache-Control": "private, no-store" };

const disabled = () => NextResponse.json({ error: "not_found" }, { status: 404 });

async function ownInstance() {
  if (!allowAppConnect) return { error: disabled() } as const;
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) } as const;
  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return { error: NextResponse.json({ error: "no_instance" }, { status: 409 }) } as const;
  return { session, instanceId } as const;
}

/** Platform error codes the panel knows how to explain; anything else is generic. */
const PASS_THROUGH = new Set([
  "integrations_not_enabled",
  "integrations_unavailable",
  "no_connection_needed",
  "app_not_connectable",
  "rate_limited",
  "not_found",
  "unknown_app",
]);

function upstreamError(status: number, body: unknown) {
  const code = (body as { error?: unknown })?.error;
  const error = typeof code === "string" && PASS_THROUGH.has(code) ? code : "upstream_error";
  return NextResponse.json({ error }, { status: status >= 400 && status < 500 ? status : 502 });
}

export async function GET() {
  const own = await ownInstance();
  if ("error" in own) return own.error;
  try {
    const result = await getApps(own.instanceId);
    if (!result.ok) return upstreamError(result.status, result.body);
    const data = (result.body as { data?: Record<string, unknown> }).data ?? {};
    const connections = (Array.isArray(data.connections) ? data.connections : [])
      .map((c) => c as { id?: unknown; app?: unknown; status?: unknown })
      .filter((c) => typeof c.id === "string" && typeof c.app === "string")
      .map((c) => ({ id: c.id as string, app: c.app as string, status: typeof c.status === "string" ? c.status : "" }));
    const managedApps = (Array.isArray(data.managed_apps) ? data.managed_apps : []).filter(
      (s): s is string => typeof s === "string",
    );
    return NextResponse.json({ enabled: data.enabled === true, connections, managedApps }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const own = await ownInstance();
  if ("error" in own) return own.error;
  if (paymentsEnabled) {
    const user = await getStore().getUserById(own.session.userId);
    if (user?.billingStatus !== "active") return NextResponse.json({ error: "payment_required" }, { status: 402 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const app = typeof (body as { app?: unknown })?.app === "string" ? ((body as { app: string }).app).trim().toLowerCase() : "";
  if (!SLUG_RE.test(app)) return NextResponse.json({ error: "invalid_app" }, { status: 400 });

  const rl = await rateLimit("apps-connect", own.session.userId, 20, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const result = await connectApp(own.instanceId, app);
    if (!result.ok) return upstreamError(result.status, result.body);
    const data = (result.body as { data?: { redirect_url?: unknown } }).data ?? {};
    if (typeof data.redirect_url !== "string" || !/^https:\/\//.test(data.redirect_url)) {
      return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    }
    // The platform's own notice is free text and could name the platform; the
    // panel shows its own localized line naming this storefront instead.
    return NextResponse.json({ redirectUrl: data.redirect_url }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const own = await ownInstance();
  if ("error" in own) return own.error;
  const connectionId = request.nextUrl.searchParams.get("id") ?? "";
  if (!CONNECTION_ID_RE.test(connectionId)) return NextResponse.json({ error: "invalid_connection_id" }, { status: 400 });

  const rl = await rateLimit("apps-disconnect", own.session.userId, 20, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const result = await disconnectApp(own.instanceId, connectionId);
    if (!result.ok) return upstreamError(result.status, result.body);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
