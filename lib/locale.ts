import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, type Locale } from "./i18n";
import {
  normalizeHostname,
  parseConfiguredHosts,
  parseConfiguredLocale,
} from "./localeConfig";

export interface LocaleState {
  locale: Locale;
  locked: boolean;
}

export async function getLocaleState(): Promise<LocaleState> {
  // SITE_LOCALE locks a single-domain deployment. Host mappings let one running
  // storefront serve separate, language-specific demo domains without copying
  // the app or its user store.
  const fixedLocale = parseConfiguredLocale(process.env.SITE_LOCALE);
  if (fixedLocale) return { locale: fixedLocale, locked: true };

  // Deliberately use Host, which Caddy preserves. Do not trust X-Forwarded-Host:
  // clients can spoof it unless every proxy in front of the app sanitizes it.
  const hostname = normalizeHostname((await headers()).get("host") ?? "");
  if (parseConfiguredHosts(process.env.LOCALE_HOST_ZH).has(hostname)) {
    return { locale: "zh", locked: true };
  }
  if (parseConfiguredHosts(process.env.LOCALE_HOST_EN).has(hostname)) {
    return { locale: "en", locked: true };
  }

  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return { locale: value === "zh" ? "zh" : "en", locked: false };
}

export async function getLocale(): Promise<Locale> {
  return (await getLocaleState()).locale;
}
