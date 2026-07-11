import { getLocale } from "../../lib/locale";
import SignupForm from "./SignupForm";

export default async function SignupPage() {
  return <SignupForm locale={await getLocale()} />;
}
