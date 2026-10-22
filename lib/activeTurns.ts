/**
 * Chat turns still running upstream, per customer. A turn keeps running after
 * the browser leaves (app/api/chat/route.ts), so a reload must be able to show
 * "still working" and pick the answer up from history once it lands.
 *
 * A storefront launched from the dashboard is one pm2 fork process, so memory
 * is the source of truth. A restart forgets a running turn, which only means
 * the page stops waiting for it. On a serverless host each instance has its own
 * memory, so a reload there may simply not see the turn: the same behaviour as
 * before this existed, never a wrong answer.
 */
export type ActiveTurn = { input: string; startedAt: string };

// Long agent jobs finish well inside this; past it the entry is treated as dead.
export const MAX_TURN_MS = 30 * 60_000;

// One registry per process. Next compiles each route into its own bundle and
// can give each a separate copy of this module, so a plain module-level Map in
// the chat route would be invisible to the history route; globalThis is shared.
const registry = ((globalThis as { __activeTurns?: { turns: Map<string, ActiveTurn & { token: symbol; since: number }>; clearing: Set<string> } }).__activeTurns ??= {
  turns: new Map(),
  clearing: new Set(),
});
const turns = registry.turns;

export function beginActiveTurn(userId: string, input: string, startedAt: string): symbol {
  const token = Symbol("turn");
  turns.set(userId, { input, startedAt, token, since: Date.now() });
  return token;
}

/** Ends the turn only if it is still the one `token` started. */
export function endActiveTurn(userId: string, token: symbol): void {
  if (turns.get(userId)?.token === token) turns.delete(userId);
}

export function activeTurn(userId: string, now = Date.now()): ActiveTurn | null {
  const turn = turns.get(userId);
  if (!turn) return null;
  if (now - turn.since > MAX_TURN_MS) {
    turns.delete(userId);
    return null;
  }
  return { input: turn.input, startedAt: turn.startedAt };
}

// Conversation clears in progress. A clear and a new turn must not overlap: the
// clear bumps the history generation, which would silently drop the new reply.
const clearing = registry.clearing;

/** Reserve the user's conversation for a clear; false when a turn or clear runs. */
export function beginClear(userId: string): boolean {
  if (activeTurn(userId) || clearing.has(userId)) return false;
  clearing.add(userId);
  return true;
}

export function endClear(userId: string): void {
  clearing.delete(userId);
}

export function isClearing(userId: string): boolean {
  return clearing.has(userId);
}
