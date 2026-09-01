import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { UpstashStore } from "./store.ts";

/**
 * UpstashStore against a fake Redis that actually EVALUATES the compare-and-set
 * script rather than recording that it was called.
 *
 * That distinction is the point of the file. The record is a single JSON string,
 * so a read-modify-write over the REST API has a network round trip between its
 * GET and its SET; a mock that merely returns canned values would report success
 * for the very interleaving that loses a write. So the fake keeps real state,
 * honours SET NX, and runs the CAS script's actual condition — and one test
 * injects a competing write into the exact gap.
 */

const CAS_SCRIPT =
  "if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]); return 1 end return 0";

function fakeRedis() {
  const data = new Map();
  /** Runs before the reply to the Nth matching command is produced. */
  let interceptor = null;

  const exec = (cmd) => {
    const [op, ...rest] = cmd;
    switch (op) {
      case "GET":
        return data.has(rest[0]) ? data.get(rest[0]) : null;
      case "SET": {
        const [key, value, flag] = rest;
        if (flag === "NX" && data.has(key)) return null;
        data.set(key, String(value));
        return "OK";
      }
      case "DEL": {
        const had = data.delete(rest[0]);
        return had ? 1 : 0;
      }
      case "INCR": {
        const next = Number(data.get(rest[0]) ?? 0) + 1;
        data.set(rest[0], String(next));
        return next;
      }
      case "EVAL": {
        const [script, numKeys, ...args] = rest;
        assert.equal(script, CAS_SCRIPT, "unexpected Lua script");
        const keys = args.slice(0, Number(numKeys));
        const argv = args.slice(Number(numKeys));
        // The script itself, transcribed. Deliberately a string comparison.
        if ((data.has(keys[0]) ? data.get(keys[0]) : null) === argv[0]) {
          data.set(keys[0], argv[1]);
          return 1;
        }
        return 0;
      }
      default:
        throw new Error(`fakeRedis: unsupported command ${op}`);
    }
  };

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const cmd = JSON.parse(init.body);
    calls.push(cmd);
    if (interceptor) interceptor(cmd, exec);
    return { ok: true, status: 200, json: async () => ({ result: exec(cmd) }), text: async () => "" };
  };

  return {
    data,
    calls,
    restore: () => { globalThis.fetch = realFetch; },
    /** Run `fn` just before the reply to the first command matching `match`. */
    interceptOnce(match, fn) {
      interceptor = (cmd, run) => {
        if (!match(cmd)) return;
        interceptor = null;
        fn(run);
      };
    },
  };
}

let redis = null;
afterEach(() => { redis?.restore(); redis = null; });

const USER = {
  id: "u1",
  email: "customer@example.com",
  passwordHash: "OLD_HASH",
  passwordSalt: "OLD_SALT",
  createdAt: "2026-09-01T00:00:00.000Z",
};

async function seeded() {
  redis = fakeRedis();
  const store = new UpstashStore("https://fake.upstash.io", "token");
  await store.createUser({ ...USER });
  return store;
}

test("setUserAuth writes the new credentials", async () => {
  const store = await seeded();
  await store.setUserAuth("u1", { passwordHash: "NEW_HASH", passwordSalt: "NEW_SALT" });
  const user = await store.getUserById("u1");
  assert.equal(user.passwordHash, "NEW_HASH");
  assert.equal(user.passwordSalt, "NEW_SALT");
  assert.equal(user.email, "customer@example.com", "unrelated fields must survive");
});

test("a write landing between the read and the write does not revert the reset", async () => {
  // The reported attack: a completed password reset rolled back to the OLD hash
  // by an overlapping write, leaving the customer's new password refused and the
  // old one still working.
  const store = await seeded();

  redis.interceptOnce(
    (cmd) => cmd[0] === "EVAL",
    (run) => {
      // A Stripe webhook commits while our reset is mid-flight.
      const current = JSON.parse(run(["GET", "user:u1"]));
      run(["SET", "user:u1", JSON.stringify({ ...current, billingStatus: "active" })]);
    },
  );

  await store.setUserAuth("u1", { passwordHash: "NEW_HASH", passwordSalt: "NEW_SALT" });

  const user = await store.getUserById("u1");
  assert.equal(user.passwordHash, "NEW_HASH", "the reset must survive the concurrent write");
  assert.equal(user.billingStatus, "active", "and the concurrent write must survive the reset");
});

test("the same protection covers billing writes", async () => {
  const store = await seeded();
  redis.interceptOnce(
    (cmd) => cmd[0] === "EVAL",
    (run) => {
      const current = JSON.parse(run(["GET", "user:u1"]));
      run(["SET", "user:u1", JSON.stringify({ ...current, passwordHash: "RESET_HASH" })]);
    },
  );

  await store.setUserBilling("u1", { billingStatus: "active", stripeCustomerId: "cus_1" });

  const user = await store.getUserById("u1");
  assert.equal(user.billingStatus, "active");
  assert.equal(user.passwordHash, "RESET_HASH", "a password reset must not be reverted by a webhook");
  assert.equal((await store.getUserByStripeCustomerId("cus_1"))?.id, "u1");
});

test("gives up loudly rather than clobbering under relentless contention", async () => {
  const store = await seeded();
  // Every attempt is beaten to the write.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const cmd = JSON.parse(init.body);
    if (cmd[0] === "EVAL") {
      redis.data.set("user:u1", JSON.stringify({ ...USER, passwordHash: `RACE_${Math.random()}` }));
    }
    return originalFetch(url, init);
  };

  await assert.rejects(
    () => store.setUserAuth("u1", { passwordHash: "NEW_HASH" }),
    /concurrent write contention/,
  );
  assert.match(JSON.parse(redis.data.get("user:u1")).passwordHash, /^RACE_/);
});

test("clearing the token removes the field and its index entry", async () => {
  const store = await seeded();
  await store.setUserAuth("u1", { resetTokenHash: "HASH_A", resetTokenExpiresAt: 123 });
  assert.equal((await store.getUserByResetTokenHash("HASH_A"))?.id, "u1");

  await store.setUserAuth("u1", { resetTokenHash: undefined, resetTokenExpiresAt: undefined });

  const user = await store.getUserById("u1");
  assert.equal(user.resetTokenHash, undefined);
  assert.equal(user.resetTokenExpiresAt, undefined);
  assert.equal(await store.getUserByResetTokenHash("HASH_A"), null);
});

test("a replacement token retires the previous index entry", async () => {
  const store = await seeded();
  await store.setUserAuth("u1", { resetTokenHash: "HASH_A", resetTokenExpiresAt: 1 });
  await store.setUserAuth("u1", { resetTokenHash: "HASH_B", resetTokenExpiresAt: 2 });
  assert.equal(await store.getUserByResetTokenHash("HASH_A"), null);
  assert.equal((await store.getUserByResetTokenHash("HASH_B"))?.id, "u1");
});

test("a patch that does not mention the token leaves the index intact", async () => {
  const store = await seeded();
  await store.setUserAuth("u1", { resetTokenHash: "HASH_A", resetTokenExpiresAt: 1 });
  await store.setUserAuth("u1", { resetTokenExpiresAt: 999 });
  assert.equal((await store.getUserByResetTokenHash("HASH_A"))?.id, "u1");
  assert.equal((await store.getUserById("u1")).resetTokenExpiresAt, 999);
});

test("a patch for a user that does not exist is a no-op", async () => {
  const store = await seeded();
  await store.setUserAuth("ghost", { passwordHash: "X" });
  assert.equal(await store.getUserById("ghost"), null);
});

test("rotating the session version invalidates issued cookies", async () => {
  const store = await seeded();
  assert.equal(await store.getUserSessionVersion("u1"), 0);
  assert.equal(await store.rotateUserSessionVersion("u1"), 1);
  assert.equal(await store.getUserSessionVersion("u1"), 1);
});

test("a conditional write is re-checked on every CAS retry", async () => {
  // The retry re-reads the latest value, so the precondition has to be evaluated
  // against THAT value — otherwise a retry smuggles the patch past a condition
  // that stopped holding while we were losing the race.
  const store = await seeded();
  await store.setUserAuth("u1", { resetTokenHash: "HASH_A", resetTokenExpiresAt: 1 });

  redis.interceptOnce(
    (cmd) => cmd[0] === "EVAL",
    (run) => {
      // Someone spends the token first.
      const current = JSON.parse(run(["GET", "user:u1"]));
      delete current.resetTokenHash;
      delete current.resetTokenExpiresAt;
      current.passwordHash = "SPENT_BY_THE_OTHER_REQUEST";
      run(["SET", "user:u1", JSON.stringify(current)]);
    },
  );

  const applied = await store.setUserAuth(
    "u1",
    { passwordHash: "SECOND_REDEMPTION", resetTokenHash: undefined, resetTokenExpiresAt: undefined },
    "HASH_A",
  );

  assert.equal(applied, false, "the token was already spent");
  assert.equal((await store.getUserById("u1")).passwordHash, "SPENT_BY_THE_OTHER_REQUEST");
});

test("a conditional write applies when the token still matches", async () => {
  const store = await seeded();
  await store.setUserAuth("u1", { resetTokenHash: "HASH_A", resetTokenExpiresAt: 1 });
  const applied = await store.setUserAuth(
    "u1",
    { passwordHash: "NEW", resetTokenHash: undefined, resetTokenExpiresAt: undefined },
    "HASH_A",
  );
  assert.equal(applied, true);
  assert.equal((await store.getUserById("u1")).passwordHash, "NEW");
  assert.equal(await store.getUserByResetTokenHash("HASH_A"), null);
});
