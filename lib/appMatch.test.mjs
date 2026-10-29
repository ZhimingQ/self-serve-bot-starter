import { test } from "node:test";
import assert from "node:assert/strict";
import { appMatchesQuery, compactAppText, matchCatalogApps, suggestableApps } from "./appMatch.ts";

const rows = [
  ["googlecalendar", "Google Calendar"],
  ["gmail", "Gmail"],
  ["clickup", "ClickUp"],
  ["google_maps", "Google Maps"],
  ["notion", "Notion"],
];

test("matches names and slugs regardless of spaces and punctuation", () => {
  assert.deepEqual(matchCatalogApps(rows, "click up"), [["clickup", "ClickUp"]]);
  assert.deepEqual(matchCatalogApps(rows, "google-maps"), [["google_maps", "Google Maps"]]);
  assert.equal(compactAppText("Click-Up 2"), "clickup2");
});

test("ranks exact, then prefix, then contains, and caps the list", () => {
  const many = [["xgoogle", "Xgoogle"], ["googledrive", "Google Drive"], ["google", "Google"], ["googlesheets", "Google Sheets"]];
  assert.deepEqual(matchCatalogApps(many, "google").map(([s]) => s), ["google", "googledrive", "googlesheets"]);
});

test("needs at least three letters and a real name match", () => {
  assert.deepEqual(matchCatalogApps(rows, "gm"), []);
  assert.deepEqual(matchCatalogApps(rows, "memory"), []);
});

test("appMatchesQuery keeps every row for an empty query", () => {
  assert.equal(appMatchesQuery(["gmail", "Gmail"], ""), true);
  assert.equal(appMatchesQuery(["clickup", "ClickUp"], "click up"), true);
  assert.equal(appMatchesQuery(["notion", "Notion"], "gmail"), false);
  assert.equal(appMatchesQuery(["gmail", "Gmail"], "+++"), false);
  assert.equal(appMatchesQuery(["weights_and_biases", "Weights & Biases"], "db"), false);
  assert.equal(appMatchesQuery(["weights_and_biases", "Weights & Biases"], "we"), true);
  assert.equal(appMatchesQuery(["google_maps", "Google Maps"], "google m"), true);
});

const catalog = [{ s: "gmail", n: "Gmail" }, { s: "clickup", n: "ClickUp" }, { s: "composio_search", n: "Composio Search" }];

test("suggestableApps names nothing when the availability check failed or Apps are off", () => {
  assert.deepEqual(suggestableApps(catalog, null, false).rows, []);
  assert.deepEqual(suggestableApps(catalog, { enabled: false }, false).rows, []);
});

test("suggestableApps keeps to managedApps, hides platform names and marks connected apps", () => {
  const r = suggestableApps(catalog, { enabled: true, managedApps: ["gmail"], connections: [{ app: "gmail", status: "active" }, { app: "clickup", status: "expired" }] }, false);
  assert.deepEqual(r.rows, [["gmail", "Gmail"]]);
  assert.deepEqual([...r.connected], ["gmail"]);
  assert.deepEqual(suggestableApps(catalog, { enabled: true }, false).rows, [["gmail", "Gmail"], ["clickup", "ClickUp"]]);
});

test("suggestableApps uses the catalog alone in the public preview", () => {
  assert.deepEqual(suggestableApps(catalog, null, true).rows, [["gmail", "Gmail"], ["clickup", "ClickUp"]]);
});
