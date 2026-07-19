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

test("uses workspace language instead of physical retail terms in Chinese copy", () => {
  const physicalRetailTerms = /门店|店面|店铺/;
  const offendingKeys = Object.entries(messages.zh)
    .filter(([, value]) => {
      const renderedValue = typeof value === "function" ? value("测试") : value;
      return physicalRetailTerms.test(renderedValue);
    })
    .map(([key]) => key);

  assert.deepEqual(offendingKeys, []);
});
