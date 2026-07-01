import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ChatApp from "./ChatApp";

/**
 * Server component: gates the authed area behind the session cookie and
 * redirects signed-out visitors to /login. The actual provisioning +
 * chat UI is a client component (ChatApp) since it needs to poll and
 * stream from the browser.
 */
export default async function AppPage() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return <ChatApp email={session.email} />;
}
