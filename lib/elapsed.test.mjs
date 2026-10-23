import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, ELAPSED_SHOW_AFTER_MS } from "./elapsed.ts";

test("formats minutes and zero-padded seconds", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7_400), "0:07");
  assert.equal(formatElapsed(102_000), "1:42");
  assert.equal(formatElapsed(723_999), "12:03");
});

test("never shows a negative or broken time", () => {
  assert.equal(formatElapsed(-5_000), "0:00");
  assert.equal(formatElapsed(Number.NaN), "0:00");
  assert.equal(formatElapsed(Number.POSITIVE_INFINITY), "0:00");
});

test("a quick reply never shows the counter", () => {
  assert.ok(ELAPSED_SHOW_AFTER_MS >= 3_000);
});
