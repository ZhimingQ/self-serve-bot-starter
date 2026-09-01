import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

// config.ts snapshots process.env at module load, and getStore() caches its
// backend on first use, so the environment has to be in place BEFORE the module
// graph is pulled in — hence the dynamic import below rather than a static one.
const STORE = mkdtempSync(path.join(tmpdir(), "reset-lib-"));
process.env.STORE_DIR = STORE;
process.env.RESEND_API_KEY = "re_test_key";
process.env.RESET_EMAIL_FROM = "bot@shop.example.com";
process.env.APP_URL = "https://shop.example.com";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const {
  RESET_TTL_MS,
  completePasswordReset,
  findUserForResetToken,
  hashToken,
  requestPasswordReset,
  isPublicAppUrl,
  resetEmailConfigured,
} = await import("./passwordReset.ts");
const { getStore } = await import("./store.ts");
const { hashPassword, verifyPassword } = await import("./password.ts");

after(() => rmSync(STORE, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
let sends = [];
let sendStatus = 200;

beforeEach(() => {
  sends = [];
  sendStatus = 200;
  globalThis.fetch = async (url, init) => {
    sends.push({ url: String(url), init, body: JSON.parse(init.body) });
    return {
      ok: sendStatus >= 200 && sendStatus < 300,
      status: sendStatus,
      text: async () => "stub",
    };
  };
});

after(() => { globalThis.fetch = realFetch; });

let seq = 0;
async function makeUser(password = "original-password") {
  seq += 1;
  const email = `customer${seq}@example.com`;
  const { hash, salt } = await hashPassword(password);
  await getStore().createUser({
    id: `user-${seq}`,
    email,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  return { id: `user-${seq}`, email };
}

/** The only copy of a real token is the one in the email — same as production. */
function tokenFromLastEmail() {
  const text = sends.at(-1)?.body?.text ?? "";
  const match = text.match(/reset-password#token=([A-Za-z0-9%._-]+)/);
  assert.ok(match, `no reset link in email body: ${text}`);
  return decodeURIComponent(match[1]);
}

test("reports configured when an API key and a from address are both present", () => {
  assert.equal(resetEmailConfigured(), true);
});

test("sends a link the token in the store resolves back to", async () => {
  const user = await makeUser();

  const outcome = await requestPasswordReset(user.email);
  assert.deepEqual(outcome, { sent: true });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, "https://api.resend.com/emails");
  assert.equal(sends[0].init.headers.Authorization, "Bearer re_test_key");
  assert.equal(sends[0].body.from, "bot@shop.example.com");
  assert.deepEqual(sends[0].body.to, [user.email]);
  assert.match(sends[0].body.text, /^https:\/\/shop\.example\.com\/reset-password#token=/m);
  assert.doesNotMatch(sends[0].body.text, /reset-password\?token=/, "a query-string token would be written to the access log");

  const resolved = await findUserForResetToken(tokenFromLastEmail());
  assert.equal(resolved?.id, user.id);
});

test("stores only the token's hash, never the token itself", async () => {
  const user = await makeUser();
  await requestPasswordReset(user.email);
  const token = tokenFromLastEmail();

  const stored = await getStore().getUserById(user.id);
  assert.equal(stored.resetTokenHash, hashToken(token));
  assert.notEqual(stored.resetTokenHash, token);
  assert.ok(stored.resetTokenExpiresAt > Date.now());
  assert.ok(stored.resetTokenExpiresAt <= Date.now() + RESET_TTL_MS);
});

test("says nothing and sends nothing for an address with no account", async () => {
  const outcome = await requestPasswordReset("nobody@example.com");
  assert.deepEqual(outcome, { sent: false, reason: "no_user" });
  assert.equal(sends.length, 0);
});

test("retires the token when the email fails to send", async () => {
  const user = await makeUser();
  sendStatus = 500;

  const outcome = await requestPasswordReset(user.email);
  assert.deepEqual(outcome, { sent: false, reason: "send_failed" });

  // A live token nobody can receive is a standing takeover risk, so the failure
  // path must roll it back rather than leave it behind.
  const stored = await getStore().getUserById(user.id);
  assert.equal(stored.resetTokenHash, undefined);
  assert.equal(await findUserForResetToken(tokenFromLastEmail()), null);
});

test("a second request invalidates the first link", async () => {
  const user = await makeUser();
  await requestPasswordReset(user.email);
  const first = tokenFromLastEmail();
  await requestPasswordReset(user.email);
  const second = tokenFromLastEmail();

  assert.notEqual(first, second);
  assert.equal(await findUserForResetToken(first), null);
  assert.equal((await findUserForResetToken(second))?.id, user.id);
});

test("refuses an expired token", async () => {
  const user = await makeUser();
  await requestPasswordReset(user.email);
  const token = tokenFromLastEmail();

  // Re-send the SAME hash alongside the past expiry. Patching the expiry alone
  // would leave the token unfindable for a second reason (the index entry moves)
  // and the assertion below would pass without the expiry check running at all.
  await getStore().setUserAuth(user.id, {
    resetTokenHash: hashToken(token),
    resetTokenExpiresAt: Date.now() - 1,
  });
  assert.ok(
    await getStore().getUserByResetTokenHash(hashToken(token)),
    "the index must still resolve, so only expiry can reject the token",
  );

  assert.equal(await findUserForResetToken(token), null);
  assert.equal(await completePasswordReset(token, "h", "s"), false);
});

test("sets the new password and spends the token exactly once", async () => {
  const user = await makeUser("original-password");
  await requestPasswordReset(user.email);
  const token = tokenFromLastEmail();

  const { hash, salt } = await hashPassword("chosen-by-customer");
  assert.equal(await completePasswordReset(token, hash, salt), true);

  const stored = await getStore().getUserById(user.id);
  assert.equal(await verifyPassword("chosen-by-customer", stored.passwordHash, stored.passwordSalt), true);
  assert.equal(await verifyPassword("original-password", stored.passwordHash, stored.passwordSalt), false);
  assert.equal(stored.resetTokenHash, undefined);
  assert.equal(stored.resetTokenExpiresAt, undefined);

  // Replaying the same link must not work.
  assert.equal(await completePasswordReset(token, hash, salt), false);
});

test("signs out existing sessions when the reset completes", async () => {
  const user = await makeUser();
  await getStore().rotateUserSessionVersion(user.id);
  const before = await getStore().getUserSessionVersion(user.id);

  await requestPasswordReset(user.email);
  const { hash, salt } = await hashPassword("new-password-here");
  await completePasswordReset(tokenFromLastEmail(), hash, salt);

  assert.equal(await getStore().getUserSessionVersion(user.id), before + 1);
});

test("rejects tokens that are the wrong shape without touching the store", async () => {
  for (const bad of ["", "short", "x".repeat(129), "!".repeat(64)]) {
    assert.equal(await findUserForResetToken(bad), null);
  }
});

// The "email not configured" case lives in passwordReset.unconfigured.test.mjs:
// config.ts snapshots process.env once per process, so observing a different
// environment needs a different process, which is exactly what node:test gives
// each test FILE.

test("only sends links to a host the customer's mail client can actually reach", () => {
  const reachable = [
    "https://shop.example.com",
    "https://store-b9744c.openclawlaunch.app",
    "http://shop.example.com:3000",
    "https://shop.example.com/",
  ];
  const unreachable = [
    "",                              // unset
    "http://localhost:3000",         // lib/config.ts's default
    "https://localhost",
    "http://app.localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.1.2.3",
    "http://storefront:3000",        // a docker service name — resolves only inside the network
    "shop.example.com",              // no scheme, so not a link at all
    "ftp://shop.example.com",
    "javascript:alert(1)",
  ];
  for (const url of reachable) assert.equal(isPublicAppUrl(url), true, url);
  for (const url of unreachable) assert.equal(isPublicAppUrl(url), false, url);
});
