import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { paymentsEnabled } from "../../../lib/config";
import { getSkills, installSkill, removeSkill } from "../../../lib/buildResell";
import catalog from "../../../lib/skillCatalog.json";

/**
 * Skills — ready-made know-how the customer can add to their assistant
 * (reports, proposals, invoices, SEO, research...).
 *
 * Same scoping as the apps route: the instance id comes from the SESSION and
 * the reseller's key stays on the server. Only the curated list in
 * lib/skillCatalog.json can be added or removed from here, so a customer can
 * never pull an unvetted marketplace skill onto their bot, nor delete a skill
 * the assistant made for itself.
 *
 * Adding needs an active plan when payments are on; listing and removing do not.
 */

const OFFERED = new Set((catalog as { skills: { s: string }[] }).skills.map((x) => x.s));
const NO_STORE = { "Cache-Control": "private, no-store" };

async function ownInstance() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) } as const;
  const instanceId = await getStore().getUserInstance(session.userId);
  if (!instanceId) return { error: NextResponse.json({ error: "no_instance" }, { status: 409 }) } as const;
  return { session, instanceId } as const;
}

/** Platform error codes the panel knows how to explain; anything else is generic. */
const PASS_THROUGH = new Set([
  "not_running",
  "busy",
  "unreachable",
  "name_taken",
  "refresh_failed",
  "install_incomplete",
  "rate_limited",
  "not_found",
]);

function upstreamError(status: number, body: unknown) {
  const code = (body as { error?: unknown })?.error;
  const error = typeof code === "string" && PASS_THROUGH.has(code) ? code : "upstream_error";
  return NextResponse.json({ error }, { status: status >= 400 && status < 500 ? status : 502 });
}

function readSkill(raw: unknown): string | null {
  const slug = typeof raw === "string" ? raw.trim() : "";
  return OFFERED.has(slug) ? slug : null;
}

export async function GET() {
  const own = await ownInstance();
  if ("error" in own) return own.error;
  try {
    const result = await getSkills(own.instanceId);
    if (!result.ok) return upstreamError(result.status, result.body);
    const rows = ((result.body as { data?: { skills?: unknown } }).data?.skills ?? []) as unknown[];
    const slugs = (Array.isArray(rows) ? rows : [])
      .map((r) => (r as { slug?: unknown }).slug)
      .filter((s): s is string => typeof s === "string");
    // Only the curated ones are named; the rest are counted, never listed.
    const installed = slugs.filter((s) => OFFERED.has(s));
    return NextResponse.json({ installed, others: slugs.length - installed.length }, { headers: NO_STORE });
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
  const skill = readSkill((body as { skill?: unknown })?.skill);
  if (!skill) return NextResponse.json({ error: "invalid_skill" }, { status: 400 });

  const rl = await rateLimit("skills-add", own.session.userId, 30, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const result = await installSkill(own.instanceId, skill);
    if (!result.ok) return upstreamError(result.status, result.body);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const own = await ownInstance();
  if ("error" in own) return own.error;
  const skill = readSkill(request.nextUrl.searchParams.get("skill"));
  if (!skill) return NextResponse.json({ error: "invalid_skill" }, { status: 400 });

  const rl = await rateLimit("skills-remove", own.session.userId, 30, 3600);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  try {
    const result = await removeSkill(own.instanceId, skill);
    if (!result.ok) return upstreamError(result.status, result.body);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
