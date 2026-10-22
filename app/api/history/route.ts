import { NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { rateLimit } from "../../../lib/rateLimit";
import { activeTurn, beginClear, endClear } from "../../../lib/activeTurns";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // A turn still running upstream (the customer reloaded or came back early).
  // Read it BEFORE history: a turn saves its reply and only then ends, so when
  // this says "not running" the history read below already holds the reply.
  const running = activeTurn(session.userId);
  const messages = await getStore().getUserHistory(session.userId);
  // The turn may have saved its reply during the read; then it is history, not
  // work, and the client must never be told about it twice.
  const saved = running && messages.some((m) => m.role === "user" && m.createdAt === running.startedAt);
  const working = saved ? null : running;
  return NextResponse.json({ messages, working }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rl = await rateLimit("history-clear", session.userId, 5, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  // Not while a turn is still running (another tab, or a reload mid-turn), and
  // no new turn may start until this clear is done (lib/activeTurns.ts).
  if (!beginClear(session.userId)) return NextResponse.json({ error: "busy" }, { status: 409 });
  try {
    await getStore().clearUserConversation(session.userId);
    return NextResponse.json({ cleared: true });
  } finally {
    endClear(session.userId);
  }
}
