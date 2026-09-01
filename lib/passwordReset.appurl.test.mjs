import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * A storefront with reset email configured but no usable APP_URL — the shape of
 * every "Deploy via your bot" install, whose generated .env carries no APP_URL
 * at all and so falls back to http://localhost:3000.
 *
 * Sending here would produce a real email containing a link that resolves only
 * on the server itself. Refusing sends the customer to support instead, which is
 * a route that actually ends somewhere.
 *
 * Own file because config.ts snapshots process.env once per process.
 */
const STORE = mkdtempSync(path.join(tmpdir(), "reset-appurl-"));
process.env.STORE_DIR = STORE;
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESET_EMAIL_FROM = "bot@shop.example.com";
delete process.env.APP_URL; // → lib/config.ts defaults to http://localhost:3000
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { requestPasswordReset, resetEmailConfigured } = await import("./passwordReset.ts");
const { getStore } = await import("./store.ts");
const { hashPassword } = await import("./password.ts");
const { appUrl } = await import("./config.ts");

after(() => rmSync(STORE, { recursive: true, force: true }));

test("the default APP_URL really is loopback, so this file tests what it claims", () => {
  assert.equal(appUrl, "http://localhost:3000");
});

test("a Resend key alone does not count as configured", () => {
  assert.equal(resetEmailConfigured(), false);
});

test("mints no token and sends nothing when the link would be unreachable", async () => {
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
