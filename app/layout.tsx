import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { brand } from "../lib/config";
import { messages } from "../lib/i18n";
import { getLocale } from "../lib/locale";
import "./globals.css";

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
      <body>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
