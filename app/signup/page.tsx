import { getLocaleState } from "../../lib/locale";
import SignupForm from "./SignupForm";

export default async function SignupPage() {
  const { locale, locked } = await getLocaleState();
  return <SignupForm locale={locale} localeLocked={locked} />;
}
