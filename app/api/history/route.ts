import { NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const messages = await getStore().getUserHistory(session.userId);
  return NextResponse.json({ messages }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rl = await rateLimit("history-clear", session.userId, 5, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  await getStore().clearUserConversation(session.userId);
  return NextResponse.json({ cleared: true });
}
