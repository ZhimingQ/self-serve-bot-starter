import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeHostname,
  parseConfiguredHosts,
  parseConfiguredLocale,
  validateLocaleConfig,
} from "./localeConfig.ts";
import { messages } from "./i18n.ts";
import { PROVIDERS } from "./providers.ts";

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

test("gives every funding provider a note in both locales", () => {
  // The en/zh alignment test below could NOT catch this: on 2026-09-03 the
  // `nousportal` and `opencode-go` providers were added to PROVIDERS and BOTH
  // locale blocks were left without a note, so the two stayed perfectly aligned
  // with each other while being incomplete against the real provider list.
  //
  // The cost was silent and lasted 13 days. `Messages` is a union of the two
  // locale objects, so `copy.providerNote[option.id]` in ModelKeyPanel stops
  // typechecking the moment an id is missing from either — which failed the
  // standalone build, which made the prebuilt storefront artifact get SKIPPED,
  // which pushed every storefront install onto the much slower in-container
  // build. Nothing surfaced it: the main app still deployed green, because the
  // artifact step is allowed to fail soft.
  //
  // So this asserts the invariant the alignment test structurally cannot: every
  // id in PROVIDERS is represented in each locale's providerNote.
  // Imports the REAL array rather than regex-parsing ModelKeyPanel.tsx. The
  // first version of this guard did parse it, and review showed the parse could
  // silently return a SHORT list — one entry in single quotes, another with two
  // spaces after `id:`, and it read 11 of 13 ids and passed while two providers
  // had no note. A completeness check that can quietly check less than the whole
  // set is worse than none, because it reports all-clear either way.
  assert.ok(PROVIDERS.length > 1, "PROVIDERS looks empty");

  for (const locale of ["en", "zh"]) {
    const notes = messages[locale].providerNote;
    const missing = PROVIDERS.map((p) => p.id).filter(
      (id) => typeof notes[id] !== "string" || notes[id].length === 0
    );
    assert.deepEqual(missing, [], `providerNote is missing entries in ${locale}`);
  }

  // The reverse direction too: a note for an id no longer offered is dead copy
  // that translators keep maintaining.
  for (const locale of ["en", "zh"]) {
    const ids = new Set(PROVIDERS.map((p) => p.id));
    assert.deepEqual(
      Object.keys(messages[locale].providerNote).filter((k) => !ids.has(k)),
      [],
      `providerNote has stale entries in ${locale}`
    );
  }
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
