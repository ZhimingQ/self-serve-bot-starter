import { notFound } from "next/navigation";
import { brand, demoMode, demoSignupUrl } from "../../lib/config";
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
  const locale = requestedLocale === "zh" ? "zh" : localeState.locale;
  // A query override is intentionally fixed for this shareable preview URL.
  // ChatApp also updates the document lang after hydration so assistive tech and
  // the Chinese typography rules match the visible language.
  const localeLocked = requestedLocale === "zh" || localeState.locked;

  return (
    <ChatApp
      email="demo@launchbot.example"
      paid
      paymentsEnabled={false}
      locale={locale}
      localeLocked={localeLocked}
      brandName={brand.name}
      brandLogoUrl={brand.logoUrl}
      templateUrl={demoSignupUrl}
      preview
    />
  );
}
