import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getStore } from "@/lib/store";
import { streamResponse } from "@/lib/buildResell";

/**
 * Pipes the upstream SSE stream from the Build & Resell API straight
 * through to the browser (no buffering), and persists the
 * `x-openclaw-session-id` response header so the next turn keeps
 * multi-turn memory.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: { input?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = body.input?.trim();
  if (!input) {
    return NextResponse.json({ error: "input is required" }, { status: 400 });
  }

  const store = getStore();
  const instanceId = await store.getUserInstance(session.userId);
  if (!instanceId) {
    return NextResponse.json(
      { error: "Your bot has not been provisioned yet" },
      { status: 400 }
    );
  }

  const existingSessionId = await store.getUserSession(session.userId);

  let upstream: Response;
  try {
    upstream = await streamResponse({
      instanceId,
      input,
      sessionId: existingSessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const newSessionId = upstream.headers.get("x-openclaw-session-id");
  if (newSessionId && newSessionId !== existingSessionId) {
    await store.setUserSession(session.userId, newSessionId);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
