import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";
import { streamResponse } from "../../../lib/buildResell";
import { assistantInstructions, paymentsEnabled, studentWorkspace } from "../../../lib/config";
import { studentTutorRules } from "../../../lib/studentTutor";
import { rateLimit } from "../../../lib/rateLimit";
import {
  consumeAssistantSseText,
  createAssistantStreamCapture,
  prepareAssistantInput,
} from "../../../lib/customerWorkspace";
import { activeTurn, beginActiveTurn, endActiveTurn, isClearing, MAX_TURN_MS } from "../../../lib/activeTurns";

// Cap message length: protects the reseller's LLM cost and avoids forwarding an
// accidental multi-MB payload upstream. ~16k chars ≈ a long message, not an essay-bomb.
const MAX_INPUT_CHARS = 16_000;
// Unread SSE chunks a connected browser may fall behind by before it is dropped.
const MAX_CLIENT_BACKLOG_CHUNKS = 2_000;

/**
 * Pipes the upstream SSE stream from the Build & Resell API straight
 * through to the browser (no buffering), and persists the
 * `x-openclaw-session-id` response header so the next turn keeps
 * multi-turn memory.
 *
 * The upstream is read to the end even when the browser goes away: a research
 * answer can take minutes, and a reload or a closed tab must not throw it away.
 * The reply still lands in history, and /api/history reports the turn as
 * `working` meanwhile so the page can wait for it (lib/activeTurns.ts).
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
  // Read once when either the paywall or the student rules need it.
  const user = paymentsEnabled || studentWorkspace ? await store.getUserById(session.userId) : null;
  if (paymentsEnabled) {
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

  // One turn at a time: a reload no longer stops the running one, and two turns
  // in the same agent session would interleave.
  if (activeTurn(session.userId) || isClearing(session.userId)) {
    return NextResponse.json(
      { error: "busy", message: "Your assistant is still working on your last request." },
      { status: 409 }
    );
  }
  // Reserve the slot before any await so a double send cannot slip past the check.
  const turnToken = beginActiveTurn(session.userId, input, turnStartedAt);
  // Released on every exit before the pump below takes ownership of the turn.
  let pumpOwnsTurn = false;
  try {
    const writeFence = await store.beginUserChat(session.userId);
    const existingSessionId = await store.getUserSession(session.userId);
    const preferences = await store.getUserPreferences(session.userId);

    let upstream: Response;
    try {
      upstream = await streamResponse({
        instanceId,
        input: prepareAssistantInput(
          input,
          preferences,
          assistantInstructions(),
          studentWorkspace ? studentTutorRules(user?.student?.schoolYear) : ""
        ),
        sessionId: existingSessionId,
        // A stalled upstream must not hold the turn (and its connection) forever.
        signal: AbortSignal.timeout(MAX_TURN_MS),
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
    let client = null as ReadableStreamDefaultController<Uint8Array> | null;
    let clientGone = false;
    const toClient = (chunk: Uint8Array) => {
      if (clientGone || !client) return;
      // A browser that stops reading would make this process buffer the rest of
      // the reply; drop it instead (the reply still reaches history).
      if ((client.desiredSize ?? 0) < -MAX_CLIENT_BACKLOG_CHUNKS) {
        clientGone = true;
        try {
          client.error(new Error("client too slow"));
        } catch {
          // already closed
        }
        return;
      }
      try {
        client.enqueue(chunk);
      } catch {
        clientGone = true;
      }
    };
    const clientBody = new ReadableStream<Uint8Array>({
      start(controller) {
        client = controller;
      },
      cancel() {
        // The browser left. Keep reading upstream so the assistant finishes the job.
        clientGone = true;
      },
    });

    const saveTurn = async () => {
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
    };

    pumpOwnsTurn = true;
    void (async () => {
      const reader = upstream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          consumeAssistantSseText(capture, decoder.decode(value, { stream: true }));
          toClient(value);
        }
      } catch (error) {
        console.error("[chat] upstream stream failed:", error instanceof Error ? error.message : error);
        // A cut-off answer is saved marked as an error, never as a complete reply.
        capture.error = true;
        if (!clientGone) {
          try {
            client?.error(error);
          } catch {
            // already closed
          }
          clientGone = true;
        }
      } finally {
        try {
          await saveTurn();
        } catch (error) {
          console.error("[chat] finishing the turn failed:", error instanceof Error ? error.message : error);
        } finally {
          // The reply is saved before the turn ends, so a history read that no
          // longer sees the turn already holds its reply.
          endActiveTurn(session.userId, turnToken);
          if (!clientGone) {
            try {
              client?.close();
            } catch {
              // already closed
            }
          }
        }
      }
    })();

    return new Response(clientBody, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } finally {
    if (!pumpOwnsTurn) endActiveTurn(session.userId, turnToken);
  }
}
