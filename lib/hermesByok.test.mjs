import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress } from "./hermesByok.ts";

test("public IPv4 and IPv6 provider addresses are allowed", () => {
  // Cloudflare addresses openrouter.ai resolves to. A shared BlockList once
  // rejected every IPv4 address through its "::ffff:0:0/96" rule.
  for (const a of ["104.18.2.115", "8.8.8.8", "2606:4700::6812:273", "2001:4860:4860::8888", "2a00:1450:4001::1"]) assert.equal(isPublicAddress(a), true, a);
});

test("private, loopback, link-local and mapped addresses are refused", () => {
  for (const a of [
    "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.17.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1",
    "64:ff9b:1::a00:1", "192.88.99.2", "2001:2::1", "2001:0:4136:e378::1", "2002:a00:1::1", "3fff::1", "fec0::1",
    "240.0.0.1", "5f00::1", "100:0:0:1::1", "2001:100::1", "ff02::1", "fc00::1", "not-an-ip",
  ]) assert.equal(isPublicAddress(a), false, a);
});
