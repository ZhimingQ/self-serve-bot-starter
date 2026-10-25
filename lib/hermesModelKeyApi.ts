/**
 * /api/model-key on a Hermes storefront. Same two security properties as the
 * OpenClaw path in app/api/model-key/route.ts: the bot comes from the SESSION,
 * never from the request, and the reseller's sk_live_ key never leaves the
 * server.
 *
 * Open during the free trial too, like a paid plan (openclawlaunch.com lets a
 * trial bring its own key the same way). "Use included AI" puts a trial bot back
 * on the trial model, and when the customer pays, the platform's promote keeps a
 * bot that is on its own endpoint there instead of overwriting it. A finished
 * trial cannot change it: the assistant is paused until a plan is chosen.
 *
 * Flow for a save: resolve the endpoint (listed provider, or a public https
 * custom URL) -> prove it with one tiny chat request -> ask the platform to
 * write it and restart the bot -> keep a masked record for the panel.
 *
 * Switches for one customer run one at a time (this app is a single PM2 fork,
 * so an in-process queue is enough), and the record is only written while the
 * session still maps to the bot the switch was made on. Once the platform has
 * been called, the outcome is never reported as "nothing changed": a lost
 * answer or an unrecorded switch comes back as `uncertain`, and the panel then
 * keeps "Use included AI" within reach.
 */
import "server-only";
import { NextResponse } from "next/server";
import { getSession } from "./session";
import { getStore, type StoredModelKey } from "./store";
import { rateLimit } from "./rateLimit";
import { paymentsEnabled } from "./config";
import { setHermesModel } from "./buildResell";
import { listModels, maskKey, probeChat, resolveEndpoint } from "./hermesByok";
import { MODEL_ID_RE } from "./hermesProviders";

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

type Ctx = { userId: string; email: string; instanceId: string; allowed: boolean; trial: boolean };

const queues = new Map<string, Promise<unknown>>();
/** Run `fn` after any switch already in flight for this customer. */
function serialized<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(userId, next);
  void next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); }).catch(() => undefined);
  return next;
}

async function context(): Promise<Ctx | NextResponse> {
  const session = await getSession();
  if (!session) return json({ error: "Not authenticated" }, 401);
  const store = getStore();
  const user = await store.getUserById(session.userId);
  // The rule the dashboard uses (app/app/page.tsx): with payments on, only an
  // active plan may switch; with payments off every signed-in customer may.
  const allowed = !paymentsEnabled || user?.billingStatus === "active";
  const instanceId = await store.getUserInstance(session.userId);
  if (!instanceId) return json({ error: "no_instance" }, 409);
  return {
    userId: session.userId,
    email: session.email,
    instanceId,
    allowed,
    // This template has no free trial; the panel's trial wording never shows.
    trial: false,
  };
}

function readKey(raw: unknown): string | null {
  const key = typeof raw === "string" ? raw.trim() : "";
  // Printable ASCII only: every provider key is, and anything else cannot be
  // sent as an HTTP header value anyway.
  return key && key.length <= 400 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

async function limited(bucket: string, userId: string, max: number) {
  const rl = await rateLimit(bucket, userId, max, 3600);
  return rl.ok ? null : json({ error: "rate_limited", retryAfterSec: rl.retryAfterSec }, 429);
}

/** Write (or clear) the record only if the session still maps to `instanceId`
 *  and, for a clear, only the record that belongs to it. False = not recorded. */
async function recordFor(ctx: Ctx, record: StoredModelKey | null): Promise<boolean> {
  try {
    const store = getStore();
    if ((await store.getUserInstance(ctx.userId)) !== ctx.instanceId) return false;
    if (!record) {
      const cur = await store.getUserModelKey(ctx.userId);
      if (cur && cur.instanceId !== ctx.instanceId) return true;
    }
    await store.setUserModelKey(ctx.userId, record);
    return true;
  } catch (err) {
    console.error("[model-key] record write failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Platform answer -> our outcome. `applied` false only when the platform
 *  refused before changing anything. */
function platformOutcome(result: { ok: boolean; body: unknown }) {
  const code = (result.body as { error?: unknown }).error;
  if (result.ok) return { applied: true, pending: false } as const;
  // Saved; only the restart proof was late. It applies on the next restart.
  if (code === "restart_unconfirmed") return { applied: true, pending: true } as const;
  if (code === "not_ready") return { applied: false, error: "not_running", status: 409 } as const;
  if (code === "trial_bot") return { applied: false, error: "paid_only", status: 409 } as const;
  if (code === "no_included_key") return { applied: false, error: "no_included_key", status: 409 } as const;
  if (code === "invalid_model" || code === "invalid_body") return { applied: false, error: "probe_failed", status: 400 } as const;
  // Auth/tenancy refusals happen before the platform touches the bot.
  if (code === "not_found" || code === "not_supported" || code === "unauthorized" || code === "forbidden") {
    return { applied: false, error: "generic", status: 502 } as const;
  }
  // apply_failed and anything unexpected: the platform may have written part of it.
  return { applied: false, error: "uncertain", status: 502 } as const;
}

export async function hermesGet() {
  const ctx = await context();
  if (ctx instanceof NextResponse) return ctx;
  const rec = await getStore().getUserModelKey(ctx.userId);
  const mine = rec && rec.instanceId === ctx.instanceId ? rec : null;
  return json({
    framework: "hermes",
    allowed: ctx.allowed,
    trial: ctx.trial,
    hasKey: Boolean(mine),
    provider: mine?.provider ?? null,
    model: mine?.model ?? null,
    host: mine?.host ?? null,
    keyPreview: mine?.keyPreview ?? null,
  });
}

/** POST { provider, modelKey, baseUrl? } -> the models that key can use. */
export async function hermesListModels(request: Request) {
  const ctx = await context();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.allowed) return json({ error: "paid_only" }, 403);
  const rl = await limited("model-key-models", ctx.userId, 30);
  if (rl) return rl;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const key = readKey(body?.modelKey);
  if (!key) return json({ error: "invalid_key" }, 400);
  const ep = resolveEndpoint(String(body?.provider ?? ""), body?.baseUrl);
  if ("error" in ep) return json({ error: ep.error }, 400);
  const r = await listModels(ep, key);
  if (!r.ok) return json({ error: r.error, message: r.message }, 400);
  return json({ models: r.models });
}

/** PUT { provider, modelKey, model, baseUrl? } -> switch the bot to it. */
export async function hermesPut(request: Request) {
  const ctx = await context();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.allowed) return json({ error: "paid_only" }, 403);
  // Each accepted call costs the customer one test message and restarts the bot.
  const rl = await limited("model-key", ctx.userId, 10);
  if (rl) return rl;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const key = readKey(body?.modelKey);
  if (!key) return json({ error: "invalid_key" }, 400);
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!MODEL_ID_RE.test(model)) return json({ error: "invalid_model" }, 400);
  const ep = resolveEndpoint(String(body?.provider ?? ""), body?.baseUrl);
  if ("error" in ep) return json({ error: ep.error }, 400);

  return serialized(ctx.userId, async () => {
    const probe = await probeChat(ep, key, model);
    if (!probe.ok) return json({ error: probe.error, message: probe.message }, 400);

    let result;
    try {
      result = await setHermesModel(ctx.instanceId, { base_url: ep.baseUrl, api_key: key, model });
    } catch {
      return json({ error: "uncertain" }, 502);
    }
    const out = platformOutcome(result);
    if (!out.applied) return json({ error: out.error }, out.status);
    const recorded = await recordFor(ctx, {
      instanceId: ctx.instanceId,
      provider: ep.provider,
      model,
      keyPreview: maskKey(key),
      ...(ep.provider === "custom" ? { host: new URL(ep.baseUrl).hostname } : {}),
      setAt: new Date().toISOString(),
    });
    return json({ ok: true, restartPending: out.pending, recorded });
  });
}

/** DELETE -> back to the AI that comes with the plan. */
export async function hermesDelete() {
  const ctx = await context();
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.allowed) return json({ error: "paid_only" }, 403);
  // Its own bucket: mistyped keys spent on PUT must never lock a customer out
  // of switching back.
  const rl = await limited("model-key-back", ctx.userId, 20);
  if (rl) return rl;
  return serialized(ctx.userId, async () => {
    let result;
    try {
      result = await setHermesModel(ctx.instanceId, "included");
    } catch {
      return json({ error: "uncertain" }, 502);
    }
    const out = platformOutcome(result);
    if (!out.applied) return json({ error: out.error }, out.status);
    const recorded = await recordFor(ctx, null);
    return json({ ok: true, restartPending: out.pending, recorded });
  });
}
