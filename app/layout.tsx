import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { brand, studentWorkspace } from "../lib/config";
import { messages } from "../lib/i18n";
import { getLocale } from "../lib/locale";
import "./globals.css";

// Every page reads WORKSPACE_MODE, the branding file and the locale when it is
// served, never when it is built: the platform builds this template once and
// each storefront sets those at runtime (and can switch WORKSPACE_MODE later),
// so a page frozen at build time would show the wrong website.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const copy = messages[await getLocale()];
  return {
    title: copy.metadataTitle(brand.name),
    description: copy.metadataDescription(brand.name),
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const rootStyle = {
    "--accent": brand.accent,
    "--accent-hover": brand.readableAccent,
    "--accent-on": brand.onAccent,
  } as CSSProperties;

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} style={rootStyle}>
      <body className={studentWorkspace ? "student-site" : undefined}>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
