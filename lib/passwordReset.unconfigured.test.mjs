import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * A storefront with no RESEND_API_KEY. Its own file because config.ts snapshots
 * process.env at module load — one environment per process, and node:test gives
 * each test FILE a process.
 *
 * The behaviour under test is a refusal, and refusing is the whole point: a
 * storefront that mints a token it cannot deliver leaves a live credential in
 * the store while the customer waits for an email that was never sent.
 */
const STORE = mkdtempSync(path.join(tmpdir(), "reset-unconf-"));
process.env.STORE_DIR = STORE;
delete process.env.RESEND_API_KEY;
delete process.env.RESET_EMAIL_FROM;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { requestPasswordReset, resetEmailConfigured } = await import("./passwordReset.ts");
const { getStore } = await import("./store.ts");
const { hashPassword } = await import("./password.ts");

after(() => rmSync(STORE, { recursive: true, force: true }));

test("reports itself unconfigured", () => {
  assert.equal(resetEmailConfigured(), false);
});

test("mints no token and makes no network call", async () => {
  const { hash, salt } = await hashPassword("original-password");
  await getStore().createUser({
    id: "user-1",
    email: "customer@example.com",
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("must not be called"); };
  try {
    const outcome = await requestPasswordReset("customer@example.com");
    assert.deepEqual(outcome, { sent: false, reason: "not_configured" });
    assert.equal(calls, 0);
    assert.equal((await getStore().getUserById("user-1")).resetTokenHash, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("refuses before looking the address up, so it cannot leak who exists", async () => {
  const outcome = await requestPasswordReset("nobody@example.com");
  assert.deepEqual(outcome, { sent: false, reason: "not_configured" });
});
