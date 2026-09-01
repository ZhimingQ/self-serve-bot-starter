import { getLocaleState } from "../../lib/locale";
import ResetPasswordForm from "./ResetPasswordForm";

/**
 * The token arrives in the query string because it arrives in an email link.
 * It is read here and handed to the client form as a prop — the page itself does
 * not look the token up, so an invalid one costs no store read until the
 * customer actually submits a new password.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale, locked } = await getLocaleState();
  const { token } = await searchParams;
  return (
    <ResetPasswordForm
      locale={locale}
      localeLocked={locked}
      token={typeof token === "string" ? token : ""}
    />
  );
}
