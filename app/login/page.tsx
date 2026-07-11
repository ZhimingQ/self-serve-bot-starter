import { getLocaleState } from "../../lib/locale";
import { demoMode, demoSignupUrl } from "../../lib/config";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  const { locale, locked } = await getLocaleState();
  return (
    <LoginForm
      locale={locale}
      localeLocked={locked}
      signupHref={demoMode ? demoSignupUrl : "/signup"}
    />
  );
}
