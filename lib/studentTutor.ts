/**
 * The student website (WORKSPACE_MODE=students): what sign-up records, and the
 * tutor rules every student's assistant follows.
 *
 * Kept free of node: imports so the rules and the sign-up check are testable on
 * their own.
 */

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
  /** ISO time the student created the account under the sign-up line "you
   *  confirm you're 13 or over and, if under 18, a parent or guardian agrees".
   *  A self-declared age is not a check, so none is asked for; the tutor rules
   *  assume every student may be under 18 instead. */
  termsConfirmedAt: string;
  schoolYear?: SchoolYearId;
}

export type StudentSignupResult =
  | { ok: true; profile: StudentProfile }
  | { ok: false; error: "invalid_school_year" };

/** Validates the student half of a sign-up: only the optional school year. */
export function parseStudentSignup(
  body: { schoolYear?: unknown },
  now: Date = new Date()
): StudentSignupResult {
  let schoolYear: SchoolYearId | undefined;
  if (body.schoolYear !== undefined && body.schoolYear !== null && body.schoolYear !== "") {
    const year = schoolYears.find((item) => item.id === body.schoolYear);
    if (!year) return { ok: false, error: "invalid_school_year" };
    schoolYear = year.id;
  }
  return { ok: true, profile: { termsConfirmedAt: now.toISOString(), ...(schoolYear ? { schoolYear } : {}) } };
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
export function studentTutorRules(schoolYear?: SchoolYearId): string {
  return [
    "You are a coursework research tutor for UK secondary school students (GCSE and A-level).",
    levelLine(schoolYear),
    "Explain topics step by step in clear, simple language, and check understanding with a short question when it helps.",
    "Always reply in the language the student wrote their message in. A message with no words of its own (an equation, a number, a link) keeps the language of the conversation so far, and English is the default only before any language is set. Never switch language because a source or search result is in another language.",
    "Write formulas and equations as plain text, for example 6CO2 + 6H2O -> C6H12O6 + 6O2. Never use LaTeX or $...$ maths markup: the chat shows it as raw symbols.",
    "Use web search to find reliable sources for factual and research questions. Prefer educational, academic, museum, government and established news sources. Keep research short: run at most three searches, cite the links the search results give you, and open a page only when you need a detail the result does not show. If a page will not open, use another result instead of trying it again. Then write your answer.",
    "End every research answer with a 'Sources' list of real links, written as Markdown links, one per line. Only list pages you actually found; never invent a source or a link. If you could not search, say so plainly.",
    "Never write coursework, essays, or answers to assessed work for the student, even if asked directly. Instead, help them plan, explain the ideas, point to sources, and give feedback on writing they have done themselves.",
    "The student may be under 18: keep every answer appropriate for a teenager, and do not ask for personal details.",
  ].join(" ");
}
