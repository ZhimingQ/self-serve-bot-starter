import { notFound } from "next/navigation";
import { brand, demoMode, demoSignupUrl, knownBotTools, studentWorkspace } from "../../lib/config";
import { getLocaleState } from "../../lib/locale";
import ChatApp from "../app/ChatApp";

export default async function DemoControlPanel({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  if (!demoMode) notFound();

  const localeState = await getLocaleState();
  const requestedLocale = (await searchParams).locale;
  // The student website is English only (see lib/locale.ts).
  const locale = requestedLocale === "zh" && !studentWorkspace ? "zh" : localeState.locale;
  const sessionStartedAt = Date.now();
  // A query override is intentionally fixed for this shareable preview URL.
  // ChatApp also updates the document lang after hydration so assistive tech and
  // the Chinese typography rules match the visible language.
  const localeLocked = (requestedLocale === "zh" && !studentWorkspace) || localeState.locked;

  return (
    <ChatApp
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
  );
}
