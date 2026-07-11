import type { Locale } from "./i18n";

export function parseConfiguredLocale(value: string | undefined): Locale | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "en") return "en";
  if (normalized === "zh" || normalized === "zh-cn" || normalized === "zh-hans") {
    return "zh";
  }
  return null;
}

export function normalizeHostname(value: string): string {
  const withoutPort = value.trim().toLowerCase().split(":")[0];
  return withoutPort.replace(/\.+$/, "");
}

export function parseConfiguredHosts(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(normalizeHostname)
      .filter(Boolean)
  );
}

function isValidHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  return hostname.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

export function validateLocaleConfig(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const rawSiteLocale = env.SITE_LOCALE?.trim();

  if (rawSiteLocale && !parseConfiguredLocale(rawSiteLocale)) {
    problems.push("SITE_LOCALE must be en or zh when set.");
  }

  const rawHosts = [
    ...(env.LOCALE_HOST_EN ?? "").split(","),
    ...(env.LOCALE_HOST_ZH ?? "").split(","),
  ].map((host) => host.trim()).filter(Boolean);
  for (const rawHost of rawHosts) {
    const normalized = normalizeHostname(rawHost);
    if (!isValidHostname(normalized)) {
      problems.push(`Invalid locale hostname: ${rawHost}`);
    }
  }

  const enHosts = parseConfiguredHosts(env.LOCALE_HOST_EN);
  const zhHosts = parseConfiguredHosts(env.LOCALE_HOST_ZH);
  for (const hostname of enHosts) {
    if (zhHosts.has(hostname)) {
      problems.push(`Locale hostname is assigned to both English and Chinese: ${hostname}`);
    }
  }

  return problems;
}
