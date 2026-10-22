/**
 * The student website (WORKSPACE_MODE=students): who may sign up, and the tutor
 * rules every student's assistant follows.
 *
 * Kept free of node: imports so the rules and the sign-up check are testable on
 * their own.
 */

/** Under 13 is not a band: those visitors are turned away before an account
 *  exists, so it is never stored. */
export const studentAgeBands = ["13-17", "18+"] as const;
export type StudentAgeBand = (typeof studentAgeBands)[number];

export const schoolYears = [
  { id: "y9", label: "Year 9" },
  { id: "y10", label: "Year 10 (GCSE)" },
  { id: "y11", label: "Year 11 (GCSE)" },
  { id: "y12", label: "Year 12 (A-level)" },
  { id: "y13", label: "Year 13 (A-level)" },
  { id: "other", label: "Other or not at school" },
] as const;
export type SchoolYearId = (typeof schoolYears)[number]["id"];

export interface StudentProfile {
  ageBand: StudentAgeBand;
  /** ISO time the student confirmed a parent or guardian agreed. Set only for
   *  13 to 17. */
  guardianConsentAt?: string;
  schoolYear?: SchoolYearId;
}

export type StudentSignupResult =
  | { ok: true; profile: StudentProfile }
  | { ok: false; error: "under_13" | "age_required" | "guardian_consent_required" | "invalid_school_year" };

/** Validates the student half of a sign-up. The server is the authority here:
 *  the form shows the same rules, but a direct POST must not get past them. */
export function parseStudentSignup(
  body: { ageBand?: unknown; guardianConsent?: unknown; schoolYear?: unknown },
  now: Date = new Date()
): StudentSignupResult {
  const age = body.ageBand;
  if (age === "under-13") return { ok: false, error: "under_13" };
  if (typeof age !== "string" || !(studentAgeBands as readonly string[]).includes(age)) {
    return { ok: false, error: "age_required" };
  }
  const ageBand = age as StudentAgeBand;
  if (ageBand === "13-17" && body.guardianConsent !== true) {
    return { ok: false, error: "guardian_consent_required" };
  }

  let schoolYear: SchoolYearId | undefined;
  if (body.schoolYear !== undefined && body.schoolYear !== null && body.schoolYear !== "") {
    const year = schoolYears.find((item) => item.id === body.schoolYear);
    if (!year) return { ok: false, error: "invalid_school_year" };
    schoolYear = year.id;
  }

  return {
    ok: true,
    profile: {
      ageBand,
      ...(ageBand === "13-17" ? { guardianConsentAt: now.toISOString() } : {}),
      ...(schoolYear ? { schoolYear } : {}),
    },
  };
}

function levelLine(schoolYear: SchoolYearId | undefined): string {
  switch (schoolYear) {
    case "y9":
      return "The student is in Year 9, working towards GCSEs: keep explanations simple and concrete.";
    case "y10":
    case "y11":
      return "The student is studying for GCSEs: pitch explanations at GCSE level.";
    case "y12":
    case "y13":
      return "The student is studying A-levels: pitch explanations at A-level, with more depth and evaluation.";
    default:
      return "Pitch explanations at GCSE level unless the student asks for more depth.";
  }
}

/** The built-in rules, applied on every chat turn of a student storefront in
 *  addition to anything the storefront owner adds. */
export function studentTutorRules(schoolYear?: SchoolYearId, ageBand?: StudentAgeBand): string {
  return [
    "You are a coursework research tutor for UK secondary school students (GCSE and A-level).",
    levelLine(schoolYear),
    "Explain topics step by step in plain English, and check understanding with a short question when it helps.",
    "Use web search to find reliable sources for factual and research questions. Prefer educational, academic, museum, government and established news sources.",
    "End every research answer with a 'Sources' list of real links, written as Markdown links, one per line. Only list pages you actually found; never invent a source or a link. If you could not search, say so plainly.",
    "Never write coursework, essays, or answers to assessed work for the student, even if asked directly. Instead, help them plan, explain the ideas, point to sources, and give feedback on writing they have done themselves.",
    ageBand === "13-17"
      ? "The student is under 18: keep every answer appropriate for a teenager, and do not ask for personal details."
      : "Keep every answer appropriate for a school setting, and do not ask for personal details.",
  ].join(" ");
}
