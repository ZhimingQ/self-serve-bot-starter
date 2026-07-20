import assert from "node:assert/strict";
import test from "node:test";

process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";

const {
  decodeSessionToken,
  encodeSessionToken,
  isSessionVersionCurrent,
} = await import("./session.ts");

test("rotation rejects an old signed cookie and accepts the replacement", () => {
  const issuedAt = Date.now();
  const oldPayload = {
    userId: "user-1",
    email: "customer@example.com",
    iat: issuedAt,
    sessionVersion: 0,
  };
  const oldSession = decodeSessionToken(encodeSessionToken(oldPayload));
  assert.ok(oldSession);
  assert.equal(isSessionVersionCurrent(oldSession, 0), true);
  assert.equal(isSessionVersionCurrent(oldSession, 1), false);

  const replacementPayload = { ...oldPayload, sessionVersion: 1 };
  const replacement = decodeSessionToken(encodeSessionToken(replacementPayload));
  assert.ok(replacement);
  assert.equal(isSessionVersionCurrent(replacement, 1), true);
  assert.equal(replacement.iat, issuedAt, "revocation keeps the original session lifetime");
});

test("session token verification rejects tampering and expiry", () => {
  const validToken = encodeSessionToken({
    userId: "user-1",
    email: "customer@example.com",
    iat: Date.now(),
    sessionVersion: 0,
  });
  assert.equal(decodeSessionToken(`${validToken.slice(0, -1)}x`), null);

  const expiredToken = encodeSessionToken({
    userId: "user-1",
    email: "customer@example.com",
    iat: Date.now() - 31 * 24 * 60 * 60 * 1000,
    sessionVersion: 0,
  });
  assert.equal(decodeSessionToken(expiredToken), null);
});
