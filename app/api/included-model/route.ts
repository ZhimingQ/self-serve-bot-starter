import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { brand, paymentsEnabled } from "../../../lib/config";
import { getIncludedModel, setIncludedModel } from "../../../lib/buildResell";

/**
 * The included model — which of the models that come with the plan the
 * assistant runs. The dashboard's model dropdown, for this storefront's
 * customers. Independent of ALLOW_END_USER_BYOK: picking among included models
 * spends nothing of the customer's own.
 *
 * The platform decides what may be offered (only routes where the included AI is
 * capped or free) and checks every pick again; this route only narrows the
 * answer to what the panel renders. The instance id comes from the SESSION.
 */

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NO_STORE = { "Cache-Control": "private, no-store" };

interface View {
  choosable: boolean;
  models: { id: string; name: string }[];
  current: string | null;
}

function viewOf(body: unknown): View {
  const data = ((body as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  const included = (data.included ?? {}) as Record<string, unknown>;
  const model = (data.model ?? {}) as Record<string, unknown>;
  const models = Array.isArray(included.models)
    ? (included.models as unknown[])
      .map((m) => m as { id?: unknown; name?: unknown })
      .filter((m) => typeof m.id === "string" && MODEL_RE.test(m.id))
      .slice(0, 50)
      .map((m) => ({ id: m.id as string, name: typeof m.name === "string" && m.name ? m.name.slice(0, 80) : (m.id as string) }))
    : [];
  // What runs now counts only on the included route: a customer endpoint or own
  // key is not "one of the included models", whatever its id looks like.
  const current = model.on_included_route === true && typeof model.current === "string"
    ? (model.current.split("/").pop() ?? null)
    : null;
  return { choosable: included.choosable === true && models.length > 0, models, current };
}

async function context() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const store = getStore();
  const instanceId = await store.getUserInstance(session.userId);
  if (!instanceId) return NextResponse.json({ error: "no_instance" }, { status: 409 });
  // The dashboard's rule (app/app/page.tsx): with payments on, only an active
  // plan may change the assistant; with payments off every customer may.
  const user = await store.getUserById(session.userId);
  const allowed = !paymentsEnabled || user?.billingStatus === "active";
  return { userId: session.userId, instanceId, allowed, framework: brand.framework === "hermes" ? "hermes" as const : "openclaw" as const };
}

export async function GET() {
  const ctx = await context();
  if (ctx instanceof NextResponse) return ctx;
  try {
    const result = await getIncludedModel(ctx.instanceId, ctx.framework);
    if (!result.ok) return NextResponse.json({ choosable: false, models: [], current: null }, { headers: NO_STORE });
    const view = viewOf(result.body);
    // Without an active plan there is nothing to choose; the panel stays hidden.
    return NextResponse.json(ctx.allowed ? view : { ...view, choosable: false }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  const ctx = await context();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.allowed) return NextResponse.json({ error: "plan_required" }, { status: 402 });
  // Each switch restarts the assistant.
  const rl = await rateLimit("included-model", ctx.userId, 10, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const model = body && typeof body === "object" && !Array.isArray(body) ? (body as { model?: unknown }).model : undefined;
  if (typeof model !== "string" || !MODEL_RE.test(model)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    // Refuse unless the bot is on the included AI right now and the pick is
    // offered: for Hermes a PUT of "included" would otherwise also take a
    // customer off their own key.
    const now = await getIncludedModel(ctx.instanceId, ctx.framework);
    const view = now.ok ? viewOf(now.body) : null;
    if (!view || !view.choosable || view.current === null || !view.models.some((m) => m.id === model)) {
      return NextResponse.json({ error: "included_model_unavailable" }, { status: 409 });
    }
    const result = await setIncludedModel(ctx.instanceId, ctx.framework, model);
    if (result.ok) return NextResponse.json({ ok: true, model });
    const code = (result.body as { error?: unknown }).error;
    if (result.status === 429) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    if (code === "included_model_not_offered" || code === "included_model_not_allowed" || code === "not_on_included_route") {
      return NextResponse.json({ error: "included_model_unavailable" }, { status: 409 });
    }
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
