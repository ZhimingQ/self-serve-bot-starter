import { getLocaleState } from "../../lib/locale";
import { brand } from "../../lib/config";
import { resetEmailConfigured } from "../../lib/passwordReset";
import ForgotPasswordForm from "./ForgotPasswordForm";

/** Whether reset email is configured is decided on the SERVER and passed down —
 *  the API key must never reach the browser, and the form only needs the boolean. */
export default async function ForgotPasswordPage() {
  const { locale, locked } = await getLocaleState();
  return (
    <ForgotPasswordForm
      locale={locale}
      localeLocked={locked}
      emailConfigured={resetEmailConfigured()}
      supportEmail={brand.supportEmail}
    />
  );
}
