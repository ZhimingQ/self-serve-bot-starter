import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { streamResponse } from "../../../lib/buildResell";
import { paymentsEnabled } from "../../../lib/config";
import { rateLimit } from "../../../lib/rateLimit";
import {
  consumeAssistantSseText,
  createAssistantStreamCapture,
  prepareAssistantInput,
} from "../../../lib/customerWorkspace";

// Cap message length: protects the reseller's LLM cost and avoids forwarding an
// accidental multi-MB payload upstream. ~16k chars ≈ a long message, not an essay-bomb.
const MAX_INPUT_CHARS = 16_000;

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

  // Per-user chat throttle (30 turns / min) — the LLM cost path, so this is the
  // main guard against a logged-in user running up the reseller's bill.
  const rl = await rateLimit("chat", session.userId, 30, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "You're sending messages too fast. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
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
  if (input.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: "input_too_long", message: `Message is too long (max ${MAX_INPUT_CHARS} characters).` },
      { status: 413 }
    );
  }
  const turnStartedAt = new Date().toISOString();

  const store = getStore();

  // Entitlement gate (server-side, authoritative): when Stripe is configured, a
  // user whose subscription has lapsed must not keep chatting by POSTing here
  // directly — the paywall UI alone isn't enough. Mirrors /api/provision.
  if (paymentsEnabled) {
    const user = await store.getUserById(session.userId);
    if (user?.billingStatus !== "active") {
      return NextResponse.json(
        { error: "payment_required", message: "Subscribe to activate your assistant." },
        { status: 402 }
      );
    }
  }

  const instanceId = await store.getUserInstance(session.userId);
  if (!instanceId) {
    return NextResponse.json(
      { error: "Your bot has not been provisioned yet" },
      { status: 400 }
    );
  }

  const writeFence = await store.beginUserChat(session.userId);
  const existingSessionId = await store.getUserSession(session.userId);
  const preferences = await store.getUserPreferences(session.userId);

  let upstream: Response;
  try {
    upstream = await streamResponse({
      instanceId,
      input: prepareAssistantInput(input, preferences),
      sessionId: existingSessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const newSessionId = upstream.headers.get("x-openclaw-session-id");
  if (newSessionId && newSessionId !== existingSessionId) {
    await store.setUserSessionIfCurrent(session.userId, newSessionId, writeFence.generation);
  }

  const capture = createAssistantStreamCapture();
  const decoder = new TextDecoder();
  const historyBody = upstream.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      consumeAssistantSseText(capture, decoder.decode(chunk, { stream: true }));
    },
    async flush() {
      consumeAssistantSseText(capture, decoder.decode(), true);
      if (!capture.content.trim()) return;
      try {
        await store.appendUserHistory(session.userId, [
          {
            id: randomUUID(),
            role: "user",
            content: input,
            createdAt: turnStartedAt,
            turnSequence: writeFence.turnSequence,
          },
          {
            id: randomUUID(),
            role: "assistant",
            content: capture.content.trim(),
            createdAt: turnStartedAt,
            turnSequence: writeFence.turnSequence,
            ...(capture.error ? { error: true } : {}),
          },
        ], writeFence.generation);
      } catch (error) {
        // History is useful but must never turn a completed assistant reply into
        // a failed chat request when persistent storage is temporarily full.
        console.error("[chat] failed to save history:", error instanceof Error ? error.message : error);
      }
    },
  }));

  return new Response(historyBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
