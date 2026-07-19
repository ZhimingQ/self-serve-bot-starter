import assert from "node:assert/strict";
import test from "node:test";
import { getOfferKind } from "./offer.ts";

test("selects demo copy before any configured payment mode", () => {
  assert.equal(
    getOfferKind({ demoMode: true, paymentsEnabled: true, stripeMode: "subscription" }),
    "demo"
  );
});

test("selects free copy when payments are disabled", () => {
  assert.equal(
    getOfferKind({ demoMode: false, paymentsEnabled: false, stripeMode: "subscription" }),
    "free"
  );
});

test("distinguishes one-time and recurring Stripe offers", () => {
  assert.equal(
    getOfferKind({ demoMode: false, paymentsEnabled: true, stripeMode: "payment" }),
    "payment"
  );
  assert.equal(
    getOfferKind({ demoMode: false, paymentsEnabled: true, stripeMode: "subscription" }),
    "subscription"
  );
});
