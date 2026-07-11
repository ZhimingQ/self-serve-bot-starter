import { getLocale } from "../../lib/locale";
import { demoMode, demoSignupUrl } from "../../lib/config";
import LoginForm from "./LoginForm";

export default async function LoginPage() {
  return (
    <LoginForm
      locale={await getLocale()}
      signupHref={demoMode ? demoSignupUrl : "/signup"}
    />
  );
}
