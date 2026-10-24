import assert from "node:assert/strict";
import test from "node:test";
import { joinNames, landingChannels, landingTools } from "./landingFeatures.ts";

const ALL = ["wechat", "telegram", "whatsapp", "discord", "feishu", "slack"];

test("an OpenClaw storefront never advertises Slack, which OpenClaw cannot connect", () => {
  assert.deepEqual(
    landingChannels({ offered: ALL, framework: "openclaw", connectEnabled: true, locale: "en" }),
    ["telegram", "whatsapp", "discord", "wechat", "feishu"],
  );
});

test("a Hermes storefront advertises all six, Chinese visitors seeing WeChat and Feishu first", () => {
  assert.deepEqual(
    landingChannels({ offered: ALL, framework: "hermes", connectEnabled: true, locale: "zh" }),
    ["wechat", "feishu", "telegram", "whatsapp", "discord", "slack"],
  );
});

test("only what the storefront offers, and nothing when connecting is off or the framework is unknown", () => {
  assert.deepEqual(
    landingChannels({ offered: ["discord", "telegram"], framework: "hermes", connectEnabled: true, locale: "en" }),
    ["telegram", "discord"],
  );
  assert.deepEqual(landingChannels({ offered: ALL, framework: "hermes", connectEnabled: false, locale: "en" }), []);
  assert.deepEqual(landingChannels({ offered: ALL, framework: "other", connectEnabled: true, locale: "en" }), []);
});

test("one tile per enabled tool, backup and restore sharing a tile worded for what is on", () => {
  const every = ["power", "backup", "ssh", "files", "endpoint", "import", "desktop", "computer", "video"];
  assert.deepEqual(landingTools({ tools: every, byok: true, framework: "hermes" }), [
    { id: "desktop" }, { id: "files" }, { id: "computer" }, { id: "video" }, { id: "ssh" }, { id: "endpoint" },
    { id: "backup", variant: "both" }, { id: "power" }, { id: "byok" },
  ]);
  assert.deepEqual(landingTools({ tools: ["backup"], byok: false, framework: "hermes" }), [{ id: "backup", variant: "backup" }]);
  assert.deepEqual(landingTools({ tools: ["import"], byok: false, framework: "hermes" }), [{ id: "backup", variant: "restore" }]);
  assert.deepEqual(landingTools({ tools: [], byok: false, framework: "hermes" }), []);
});

test("an OpenClaw storefront never advertises Video, which the platform serves to Hermes only", () => {
  const tiles = landingTools({ tools: ["video", "files"], byok: false, framework: "openclaw" });
  assert.deepEqual(tiles, [{ id: "files" }]);
});

test("joinNames reads naturally in both languages", () => {
  const en = { sep: ", ", and: " and ", more: " and more" };
  const zh = { sep: "、", and: "和", more: "等" };
  assert.equal(joinNames([], en), "");
  assert.equal(joinNames(["Telegram"], en), "Telegram");
  assert.equal(joinNames(["Telegram", "WhatsApp", "Discord"], en), "Telegram, WhatsApp and Discord");
  assert.equal(joinNames(["Telegram", "WhatsApp", "Discord"], en, 2), "Telegram, WhatsApp and more");
  assert.equal(joinNames(["微信", "飞书", "Telegram"], zh), "微信、飞书和Telegram");
  assert.equal(joinNames(["微信", "飞书", "Telegram"], zh, 2), "微信、飞书等");
});
