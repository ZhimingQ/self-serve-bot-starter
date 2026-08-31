import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { allowChannelConnect, knownChannels, offeredChannels } from "../../../lib/config";
import { channelAction, getChannels } from "../../../lib/buildResell";

/**
 * Messaging channels — WeChat, Telegram, WhatsApp, Discord, Lark, Slack.
 *
 * Same hard scoping as the model-key route: the instance id comes from the
 * SESSION, so a customer can only ever connect their own bot, and the reseller's
 * sk_live_ key stays on the server.
 *
 * On top of that this route enforces the storefront's OWN offer. The platform
 * will connect anything the bot's framework supports; CHANNELS in .env is the
 * reseller's narrower list, and it is enforced HERE rather than only hidden in
 * the UI — a hidden tile is a suggestion, a server check is the rule.
 *
 * Bot tokens pass through to the platform, which validates them against the
 * platform's own API before anything touches the container, and are never stored
 * by this storefront.
 */

const disabled = () => NextResponse.json({ error: "not_found" }, { status: 404 });

const ACTIONS = new Set(["connect", "qr", "pairing_approve", "disconnect"]);

/** Per-action ceilings. A connect restarts the customer's container, so it is
 *  kept scarce; QR polling is a UI loop and needs real headroom (a first WeChat
 *  connect installs a plugin for minutes before the code appears). */
const LIMITS: Record<string, { max: number; windowSec: number }> = {
  connect: { max: 6, windowSec: 3600 },
  disconnect: { max: 6, windowSec: 3600 },
  pairing_approve: { max: 12, windowSec: 3600 },
  qr: { max: 150, windowSec: 3600 },
};

export async function GET() {
  if (!allowChannelConnect) return disabled();
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });

  try {
    const result = await getChannels(instanceId);
    if (!result.ok) return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    const data = (result.body as { data?: Record<string, unknown> }).data ?? {};
    const supported = (data.supported ?? {}) as { connect?: string[]; disconnect?: string[]; pairing?: string[] };
    const channels = (Array.isArray(data.channels) ? data.channels : []) as { platform: string; paired: boolean }[];
    // What a customer may CONNECT is the intersection of what the framework can do
    // and what this storefront sells — computed here so the UI and the POST checks
    // can never disagree.
    const connectable = offeredChannels.filter((id) => (supported.connect ?? []).includes(id));
    // What the panel RENDERS is that list plus anything already connected. A
    // reseller who narrows CHANNELS later must not leave a customer with a live
    // channel that has no tile, and therefore no way to turn it off.
    const alreadyConnected = channels
      .map((c) => c.platform)
      .filter((id): id is (typeof knownChannels)[number] =>
        (knownChannels as readonly string[]).includes(id) && !(connectable as string[]).includes(id));
    const tiles = [...connectable, ...alreadyConnected];
    return NextResponse.json(
      {
        status: (data.status as string) ?? "unknown",
        channels,
        tiles,
        connectable,
        disconnectable: tiles.filter((id) => (supported.disconnect ?? []).includes(id)),
        pairing: connectable.filter((id) => (supported.pairing ?? []).includes(id)),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  if (!allowChannelConnect) return disabled();
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const raw = (body ?? {}) as Record<string, unknown>;
  const action = typeof raw.action === "string" ? raw.action : "";
  const platform = typeof raw.platform === "string" ? raw.platform.toLowerCase() : "";
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  // The storefront's own offer, enforced server-side rather than only hidden in
  // the UI. Turning a channel OFF is checked against the full known set instead:
  // narrowing CHANNELS after a customer has already connected something must not
  // strand them with a live channel they can no longer disconnect.
  const allowedHere = action === "disconnect" ? (knownChannels as readonly string[]) : (offeredChannels as string[]);
  if (!allowedHere.includes(platform)) {
    return NextResponse.json({ error: "unsupported_platform" }, { status: 400 });
  }

  const limit = LIMITS[action];
  const rl = await rateLimit(`channels-${action}`, session.userId, limit.max, limit.windowSec);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  // Only the fields each action legitimately carries — nothing else from the
  // browser reaches the platform.
  const payload: Record<string, unknown> = { action, platform };
  if (action === "connect") {
    if (typeof raw.botToken === "string" && raw.botToken.trim()) payload.bot_token = raw.botToken.trim();
    if (typeof raw.appId === "string" && raw.appId.trim()) payload.app_id = raw.appId.trim();
    if (typeof raw.appSecret === "string" && raw.appSecret.trim()) payload.app_secret = raw.appSecret.trim();
  }
  if (action === "pairing_approve") {
    const code = typeof raw.code === "string" ? raw.code.trim() : "";
    if (!code) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    payload.code = code;
  }

  try {
    const result = await channelAction(instanceId, payload);
    if (result.ok) {
      const data = (result.body as { data?: Record<string, unknown> }).data ?? {};
      return NextResponse.json({ ok: true, ...data });
    }
    const upstream = result.body as { error?: unknown; message?: unknown };
    return NextResponse.json(
      {
        error: typeof upstream.error === "string" ? upstream.error : "upstream_error",
        message: typeof upstream.message === "string" ? upstream.message : undefined,
      },
      { status: result.status === 429 ? 429 : result.status >= 500 ? 502 : result.status },
    );
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
