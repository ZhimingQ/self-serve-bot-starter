import type { CSSProperties } from "react";
import { customerPreviewHref, getCustomerPreset, resolveCustomerPreset } from "../../lib/customerPresets";
import { notFound } from "next/navigation";
import { brand, accentColors, customerTemplate, demoMode, demoSignupUrl, knownBotTools, studentWorkspace } from "../../lib/config";
import { getLocaleState } from "../../lib/locale";
import ChatApp from "../app/ChatApp";

export default async function DemoControlPanel({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string; preset?: string }>;
}) {
  if (!demoMode) notFound();

  const localeState = await getLocaleState();
  const query = await searchParams;
  const requestedLocale = query.locale;
  const presetId = studentWorkspace ? "general" : resolveCustomerPreset(customerTemplate, query.preset, demoMode);
  const preset = getCustomerPreset(presetId);
  // The student website is English only (see lib/locale.ts).
  const locale = !studentWorkspace && (requestedLocale === "zh" || requestedLocale === "en") ? requestedLocale : localeState.locale;
  const sessionStartedAt = Date.now();
  // Query language is carried with the selected preset in shareable preview URLs.
  // ChatApp also updates the document lang after hydration so assistive tech and
  // the Chinese typography rules match the visible language.
  const localeLocked = localeState.locked;
  const previewStyle = presetId !== "general" ? { "--accent": preset.accent, "--accent-hover": accentColors(preset.accent).readableAccent, "--accent-on": accentColors(preset.accent).onAccent } as CSSProperties : undefined;

  return (
    <div style={previewStyle}>
      <ChatApp
        customerPresetId={presetId}
        previewHomeHref={customerPreviewHref("/", presetId, locale)}
        email="demo@launchbot.example"
        paid
        paymentsEnabled={false}
        billingMode="none"
        billingStatus="active"
        accountCreatedAt="2026-06-01T12:00:00.000Z"
        sessionStartedAt={new Date(sessionStartedAt).toISOString()}
        sessionExpiresAt={new Date(sessionStartedAt + 30 * 24 * 60 * 60 * 1000).toISOString()}
        locale={locale}
        localeLocked={localeLocked}
        brandName={brand.name}
        brandLogoUrl={brand.logoUrl}
        brandWebsiteUrl={brand.websiteUrl}
        templateUrl={demoSignupUrl}
        supportEmail={brand.supportEmail}
        privacyUrl={brand.privacyUrl}
        // The showcase always renders every self-service panel, whatever this
        // deployment sells, so a prospective reseller can see what they get.
        byokEnabled
        channelsEnabled
        botTools={[...knownBotTools]}
        termsUrl={brand.termsUrl}
        // A student storefront's demo shows the study desk its students get.
        simpleMode={studentWorkspace}
        studentMode={studentWorkspace}
        preview
      />
    </div>
  );
}
