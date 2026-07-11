"use client";

import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, messages, type Locale } from "../lib/i18n";

export default function LanguageSwitcher({ locale }: { locale: Locale }) {
  const router = useRouter();
  const nextLocale = locale === "en" ? "zh" : "en";

  return (
    <button
      type="button"
      className="language-switcher"
      aria-label={locale === "en" ? "切换到中文" : "Switch to English"}
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
        router.refresh();
      }}
    >
      {messages[locale].language}
    </button>
  );
}
