"use client";

import { useState } from "react";

// Logos we ship ourselves (public/apps); the rest come from the integration
// catalog's logo CDN.
// canva.svg is a wordmark, unreadable this small, so it is not used here.
const LOCAL_LOGOS = new Set([
  "gmail", "googlecalendar", "googledocs", "googlesheets", "googledrive", "outlook",
  "instagram", "slack", "notion", "dropbox", "github", "linkedin", "youtube",
]);
const logoOf = (slug: string) => (LOCAL_LOGOS.has(slug) ? `/apps/${slug}.svg` : `https://logos.composio.dev/api/${slug}`);

/** An app logo with the app's initial behind it, shown if the image fails. */
export default function AppLogo({ slug, name, size, lazy = true }: { slug: string; name: string; size: number; lazy?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="apps-logo" aria-hidden="true" style={{ width: size + 4, height: size + 4 }} data-i={name.charAt(0).toUpperCase()}>
      {!failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoOf(slug)}
          alt=""
          width={size}
          height={size}
          loading={lazy ? "lazy" : undefined}
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
