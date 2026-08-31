import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeHostname,
  parseConfiguredHosts,
  parseConfiguredLocale,
  validateLocaleConfig,
} from "./localeConfig.ts";
import { messages } from "./i18n.ts";

test("normalizes supported locale aliases", () => {
  assert.equal(parseConfiguredLocale("EN"), "en");
  assert.equal(parseConfiguredLocale("zh-Hans"), "zh");
  assert.equal(parseConfiguredLocale("cn"), null);
});

test("normalizes hostname case, ports, and trailing dots", () => {
  assert.equal(normalizeHostname(" ZH.Example.com.:3000 "), "zh.example.com");
  assert.deepEqual(
    [...parseConfiguredHosts("EN.Example.com:443, second.example.com.")],
    ["en.example.com", "second.example.com"]
  );
});

test("rejects invalid fixed locales and overlapping host mappings", () => {
  assert.deepEqual(validateLocaleConfig({ SITE_LOCALE: "cn" }), [
    "SITE_LOCALE must be en or zh when set.",
  ]);
  assert.deepEqual(
    validateLocaleConfig({
      LOCALE_HOST_EN: "Demo.Example.com",
      LOCALE_HOST_ZH: "demo.example.com.",
    }),
    ["Locale hostname is assigned to both English and Chinese: demo.example.com"]
  );
});

test("accepts distinct valid English and Chinese hosts", () => {
  assert.deepEqual(
    validateLocaleConfig({
      LOCALE_HOST_EN: "launchbot-demo.openclawlaunch.app",
      LOCALE_HOST_ZH: "launchbot-demo-zh.openclawlaunch.app",
    }),
    []
  );
});

/**
 * Every string in a locale, flattened to `dotted.path` → text.
 *
 * Copy stopped being one flat object when the channel and provider tables
 * arrived (`channelName.wechat`, `channelQrSteps.whatsapp[1]`), and a
 * one-level-deep walk does not fail on those — it stringifies them to
 * "[object Object]" and passes, so the checks below would have gone quietly
 * blind on exactly the newest copy. Functions are rendered with `sample` so
 * interpolated strings are checked too — and `sample` is the caller's choice
 * because a Chinese sample fed into the English check would flag every
 * interpolating string as containing Chinese, which is the tester's text, not
 * the copy's.
 */
function flattenCopy(node, sample, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "function") {
      out[path] = String(value(sample));
    } else if (Array.isArray(value)) {
      value.forEach((entry, i) => flattenCopy({ [String(i)]: entry }, sample, path, out));
    } else if (value && typeof value === "object") {
      flattenCopy(value, sample, path, out);
    } else {
      out[path] = String(value);
    }
  }
  return out;
}

test("uses one natural SaaS voice in Chinese copy", () => {
  const rejectedTerms = /门店|店面|店铺|您/;
  const offendingKeys = Object.entries(flattenCopy(messages.zh, "测试"))
    .filter(([, value]) => rejectedTerms.test(value))
    .map(([key]) => key);

  assert.deepEqual(offendingKeys, []);
});

test("keeps no Chinese in the English copy", () => {
  // A customer reading English must never meet a Han character — not in a
  // channel name (WeChat, not 微信), not in a provider note, not in a QR
  // instruction. The language switcher is the single deliberate exception:
  // its whole job is to name the other language in that language.
  const han = /[㐀-䶿一-鿿]/;
  const offendingKeys = Object.entries(flattenCopy(messages.en, "Acme"))
    .filter(([key]) => key !== "language")
    .filter(([, value]) => han.test(value))
    .map(([key]) => key);

  assert.deepEqual(offendingKeys, []);
});

test("keeps English and Chinese message keys aligned", () => {
  // Compared on the FLATTENED paths: a channel present in one locale's
  // channelName table and missing from the other renders as a blank tile, and a
  // top-level key comparison cannot see that.
  assert.deepEqual(
    Object.keys(flattenCopy(messages.en, "Acme")).sort(),
    Object.keys(flattenCopy(messages.zh, "测试")).sort()
  );
});
