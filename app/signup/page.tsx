import { getLocaleState } from "../../lib/locale";
import { brand, studentWorkspace } from "../../lib/config";
import StudentSignupForm from "../student/StudentSignupForm";
import SignupForm from "./SignupForm";

export default async function SignupPage() {
  // WORKSPACE_MODE=students asks the student's age and school year as well.
  if (studentWorkspace) return <StudentSignupForm brandName={brand.name} />;
  const { locale, locked } = await getLocaleState();
  return <SignupForm locale={locale} localeLocked={locked} />;
}
