import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { MAX_CUSTOM_INSTRUCTIONS_CHARS, normalizeAssistantPreferences } from "../../../lib/customerWorkspace";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const preferences = await getStore().getUserPreferences(session.userId);
  return NextResponse.json({ preferences }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rl = await rateLimit("preferences", session.userId, 20, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid preferences" }, { status: 400 });
  const raw = body as { customInstructions?: unknown; responseStyle?: unknown };
  if (typeof raw.customInstructions === "string" && raw.customInstructions.trim().length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
    return NextResponse.json({ error: "Instructions are too long" }, { status: 400 });
  }
  if (raw.responseStyle !== "balanced" && raw.responseStyle !== "concise" && raw.responseStyle !== "detailed") {
    return NextResponse.json({ error: "Invalid response style" }, { status: 400 });
  }
  const preferences = normalizeAssistantPreferences(body);
  await getStore().setUserPreferences(session.userId, preferences);
  return NextResponse.json({ preferences });
}
