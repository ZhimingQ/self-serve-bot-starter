import assert from "node:assert/strict";
import test from "node:test";
import { clientIp, rateLimitIdentity } from "./rateLimit.ts";

test("trusted X-Real-IP wins over a spoofable X-Forwarded-For prefix", () => {
  const request = new Request("https://example.com", {
    headers: {
      "x-real-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.1, 192.0.2.4",
    },
  });
  assert.equal(clientIp(request, true), "203.0.113.9");
});

test("X-Forwarded-For fallback uses the proxy-appended right-most hop", () => {
  const request = new Request("https://example.com", {
    headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
  });
  assert.equal(clientIp(request, true), "203.0.113.9");
});

test("forwarded headers are ignored without an explicit trusted proxy", () => {
  const request = new Request("https://example.com", {
    headers: { "x-real-ip": "203.0.113.9" },
  });
  assert.equal(clientIp(request, false), "unknown");
});

test("rate-limit identities are stable hashes without exposing the email", () => {
  const identity = rateLimitIdentity("customer@example.com");
  assert.equal(identity, rateLimitIdentity("customer@example.com"));
  assert.equal(identity.length, 64);
  assert.equal(identity.includes("customer"), false);
});
