import type { Metadata } from "next";
import type { CSSProperties } from "react";
import { brand } from "../lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: `${brand.name} — Your own AI assistant`,
  description: `Sign up and get your own AI assistant, powered by ${brand.name}.`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const rootStyle = {
    "--accent": brand.accent,
  } as CSSProperties;

  return (
    <html lang="en" style={rootStyle}>
      <body>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
