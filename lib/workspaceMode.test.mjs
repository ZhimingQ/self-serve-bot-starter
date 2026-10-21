import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkspaceMode } from "./workspaceMode.ts";

test("unset, empty and full mean the full workspace", () => {
  assert.equal(parseWorkspaceMode(undefined), "full");
  assert.equal(parseWorkspaceMode(""), "full");
  assert.equal(parseWorkspaceMode("  "), "full");
  assert.equal(parseWorkspaceMode("full"), "full");
  assert.equal(parseWorkspaceMode(" FULL "), "full");
});

test("simple selects the simple workspace", () => {
  assert.equal(parseWorkspaceMode("simple"), "simple");
  assert.equal(parseWorkspaceMode(" Simple "), "simple");
});

test("a typo reads as simple, never as full", () => {
  assert.equal(parseWorkspaceMode("simpel"), "simple");
  assert.equal(parseWorkspaceMode("chat"), "simple");
});
