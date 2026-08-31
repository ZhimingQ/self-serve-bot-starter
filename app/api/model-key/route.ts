import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { allowEndUserByok } from "../../../lib/config";
import { getModelKey, setModelKey } from "../../../lib/buildResell";

/**
 * The customer's own model key — "bring your own API key".
 *
 * This route is a thin, HARD-SCOPED proxy in front of the platform's model-key
 * endpoint. Two properties do all the security work here:
 *
 *   1. The instance id comes from the SESSION, never from the request. The
 *      browser cannot name a bot; it can only ever act on the one bot mapped to
 *      the signed-in customer. Accepting an id from the body would let any
 *      customer of this storefront re-fund — and read the provider of — every
 *      other customer's bot, since all of them sit behind the same api key.
 *   2. The reseller's sk_live_ key never leaves the server. lib/buildResell is
 *      import-guarded ("server-only") so this cannot regress into a client call.
 *
 * There is no DELETE. Removing a bot's funding leaves it running and mute, which
 * is the exact failure this feature exists to prevent; a customer who wants to
 * stop paying cancels their plan, which retires the bot.
 */

/** 404 rather than 403 when the reseller has not enabled BYOK: a customer should
 *  not learn that a panel they were never offered exists. */
const disabled = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET() {
  if (!allowEndUserByok) return disabled();
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });

  try {
    const result = await getModelKey(instanceId);
    if (!result.ok) return NextResponse.json({ error: "upstream_error" }, { status: 502 });
    const data = (result.body as { data?: Record<string, unknown> }).data ?? {};
    // Only the three fields the panel renders. `key_preview` is already masked
    // upstream and the raw key is never returned by that endpoint at all.
    return NextResponse.json(
      {
        hasKey: Boolean(data.has_key),
        provider: (data.model_key_provider as string | null) ?? null,
        keyPreview: (data.key_preview as string | null) ?? null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  if (!allowEndUserByok) return disabled();
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Low ceiling: each accepted call revalidates a key against a provider API and
  // rewrites a running bot's funding. A customer fixing a typo needs a handful of
  // tries; nothing legitimate needs more.
  const rl = await rateLimit("model-key", session.userId, 10, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const raw = (body ?? {}) as { modelKey?: unknown; provider?: unknown };
  const modelKey = typeof raw.modelKey === "string" ? raw.modelKey.trim() : "";
  if (!modelKey) return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  if (modelKey.length > 400) return NextResponse.json({ error: "invalid_key" }, { status: 400 });
  const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : undefined;

  try {
    const result = await setModelKey(instanceId, modelKey, provider);
    if (result.ok) {
      // `recorded: false` is a real, distinct outcome: the assistant IS running on
      // the new key, but our record of that did not land. Collapsing it into plain
      // success would tell the customer they are done while the next status read
      // still shows no key on file — and only saving again fixes it, which they
      // would never think to do. A repeat save is safe by design.
      const data = (result.body as { data?: { recorded?: unknown } }).data ?? {};
      return NextResponse.json({ ok: true, recorded: data.recorded !== false });
    }
    // The platform's rejection messages are written for the person holding the
    // key ("that key was rejected by the provider", "the account has no credit")
    // and are already sanitized — passing them through is what makes the failure
    // fixable. Anything without a message collapses to a code the UI localizes.
    const upstream = result.body as { error?: unknown; message?: unknown };
    return NextResponse.json(
      {
        error: typeof upstream.error === "string" ? upstream.error : "upstream_error",
        message: typeof upstream.message === "string" ? upstream.message : undefined,
      },
      { status: result.status === 429 ? 429 : result.status >= 500 ? 502 : 400 },
    );
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
