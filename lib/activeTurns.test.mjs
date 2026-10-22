import test from "node:test";
import assert from "node:assert/strict";
import { activeTurn, beginActiveTurn, beginClear, endActiveTurn, endClear, isClearing } from "./activeTurns.ts";

test("a running turn is reported until its own token ends it", () => {
  const first = beginActiveTurn("u1", "find cafes", "2026-10-15T13:00:00.000Z");
  assert.deepEqual(activeTurn("u1"), { input: "find cafes", startedAt: "2026-10-15T13:00:00.000Z" });
  const second = beginActiveTurn("u1", "next job", "2026-10-15T13:05:00.000Z");
  endActiveTurn("u1", first); // a stale finisher must not clear the newer turn
  assert.equal(activeTurn("u1")?.input, "next job");
  endActiveTurn("u1", second);
  assert.equal(activeTurn("u1"), null);
});

test("a turn older than 30 minutes is treated as dead", () => {
  beginActiveTurn("u2", "x", "2026-10-15T13:00:00.000Z");
  assert.equal(activeTurn("u2", Date.now() + 31 * 60_000), null);
  assert.equal(activeTurn("u2"), null);
});

test("a clear and a turn never overlap", () => {
  const turn = beginActiveTurn("u3", "x", "2026-10-15T13:00:00.000Z");
  assert.equal(beginClear("u3"), false); // refused while the turn runs
  endActiveTurn("u3", turn);
  assert.equal(beginClear("u3"), true);
  assert.equal(isClearing("u3"), true); // the chat route refuses new turns now
  assert.equal(beginClear("u3"), false); // and a second clear
  endClear("u3");
  assert.equal(isClearing("u3"), false);
});
