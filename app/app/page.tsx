import { redirect } from "next/navigation";
import { getSession } from "../../lib/session";
import { getStore } from "../../lib/store";
import { brand, demoSignupUrl, paymentsEnabled } from "../../lib/config";
import { confirmCheckoutSession } from "../../lib/billing";
import { getLocaleState } from "../../lib/locale";
import ChatApp from "./ChatApp";

/**
 * Server component: gates the authed area behind the session cookie and
 * redirects signed-out visitors to /login. The actual provisioning +
 * chat UI is a client component (ChatApp) since it needs to poll and
 * stream from the browser.
 */
export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const store = getStore();
  let user = await store.getUserById(session.userId);

  // Returning from Stripe Checkout: verify the session server-side and activate
  // immediately, so a paid user is never left on the paywall waiting for the
  // webhook. confirmCheckoutSession only activates a session that belongs to this
  // user AND is paid.
  const { session_id } = await searchParams;
  if (paymentsEnabled && session_id && user?.billingStatus !== "active") {
    await confirmCheckoutSession(session.userId, session_id);
    user = await store.getUserById(session.userId);
  }

  // Entitlement is read server-side so the paywall can't be bypassed by editing
  // client state; /api/provision re-checks it authoritatively too.
  const paid = user?.billingStatus === "active";
  const { locale, locked } = await getLocaleState();

  return (
    <ChatApp
      email={session.email}
      paid={paid}
      paymentsEnabled={paymentsEnabled}
      locale={locale}
      localeLocked={locked}
      brandName={brand.name}
      brandLogoUrl={brand.logoUrl}
      templateUrl={demoSignupUrl}
      supportEmail={brand.supportEmail}
      privacyUrl={brand.privacyUrl}
      termsUrl={brand.termsUrl}
    />
  );
}
