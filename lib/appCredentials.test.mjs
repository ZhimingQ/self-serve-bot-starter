import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CREDENTIAL_CHARS, readAppAuth, readCredentials, validScheme } from "./appCredentials.ts";

test("credentials are a flat object of bounded strings", () => {
  assert.deepEqual(readCredentials({ generic_api_key: "k", "suffix.one": "x" }), { generic_api_key: "k", "suffix.one": "x" });
  for (const bad of [null, undefined, "k", ["k"], {}, { a: 1 }, { "bad name": "k" }, { a: "x".repeat(MAX_CREDENTIAL_CHARS + 1) }]) {
    assert.equal(readCredentials(bad), null);
  }
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, "v"]));
  assert.equal(readCredentials(tooMany), null);
});

test("the form description keeps only what the panel draws", () => {
  const auth = readAppAuth({
    app: "apollo",
    connect: "credentials",
    scheme: "API_KEY",
    schemes: ["API_KEY", "not a scheme"],
    fields: [
      { name: "generic_api_key", label: "API Key", description: "Your key", required: true, secret: true, default: null, internal: "x" },
      { name: "region", required: false, secret: false, default: "eu" },
      { name: "bad name", label: "dropped" },
    ],
    guide_url: "https://apollo.io/keys",
    notice: "free text naming the platform",
  });
  assert.deepEqual(auth, {
    scheme: "API_KEY",
    schemes: ["API_KEY"],
    fields: [
      { name: "generic_api_key", label: "API Key", description: "Your key", required: true, secret: true, default: null },
      { name: "region", label: "region", description: "", required: false, secret: false, default: "eu" },
    ],
    guideUrl: "https://apollo.io/keys",
  });
});

test("reading the form description twice loses nothing", () => {
  const once = readAppAuth({ scheme: "API_KEY", fields: [{ name: "a", required: true }], guide_url: "https://x.example/" });
  assert.deepEqual(readAppAuth(once), once);
});

test("a field is treated as a secret unless the platform says otherwise", () => {
  assert.equal(readAppAuth({ scheme: "API_KEY", fields: [{ name: "a" }] }).fields[0].secret, true);
});

test("the 422 for a bare connect carries the same description", () => {
  assert.equal(readAppAuth({ scheme: "BASIC", schemes: ["BASIC"], fields: [{ name: "username" }] }).scheme, "BASIC");
});

test("anything that is not a credential app, or a hostile guide link, is refused", () => {
  assert.equal(readAppAuth({ connect: "sign_in" }), null);
  assert.equal(readAppAuth({ scheme: "API_KEY", fields: [] }), null);
  assert.equal(readAppAuth(undefined), null);
  assert.equal(readAppAuth({ scheme: "API_KEY", fields: [{ name: "a" }], guide_url: "javascript:alert(1)" }).guideUrl, null);
});

test("a scheme name is a plain constant", () => {
  assert.equal(validScheme("S2S_OAUTH2"), true);
  assert.equal(validScheme("api key"), false);
  assert.equal(validScheme(undefined), false);
});
