import assert from "node:assert/strict";
import test from "node:test";
import { parseStudentSignup, studentTutorRules } from "./studentTutor.ts";

const now = new Date("2026-10-22T10:00:00.000Z");

test("under 13 is refused before an account exists", () => {
  assert.deepEqual(parseStudentSignup({ ageBand: "under-13", guardianConsent: true }, now), { ok: false, error: "under_13" });
});

test("an age band is required", () => {
  assert.deepEqual(parseStudentSignup({}, now), { ok: false, error: "age_required" });
  assert.deepEqual(parseStudentSignup({ ageBand: "12" }, now), { ok: false, error: "age_required" });
  assert.deepEqual(parseStudentSignup({ ageBand: 17 }, now), { ok: false, error: "age_required" });
});

test("13 to 17 needs guardian consent, and only literal true counts", () => {
  assert.deepEqual(parseStudentSignup({ ageBand: "13-17" }, now), { ok: false, error: "guardian_consent_required" });
  assert.deepEqual(parseStudentSignup({ ageBand: "13-17", guardianConsent: "true" }, now), { ok: false, error: "guardian_consent_required" });
  assert.deepEqual(parseStudentSignup({ ageBand: "13-17", guardianConsent: true, schoolYear: "y11" }, now), {
    ok: true,
    profile: { ageBand: "13-17", guardianConsentAt: "2026-10-22T10:00:00.000Z", schoolYear: "y11" },
  });
});

test("18 and over needs no consent and records none", () => {
  assert.deepEqual(parseStudentSignup({ ageBand: "18+", guardianConsent: true }, now), { ok: true, profile: { ageBand: "18+" } });
});

test("school year is optional but must be a known one", () => {
  assert.deepEqual(parseStudentSignup({ ageBand: "18+", schoolYear: "" }, now), { ok: true, profile: { ageBand: "18+" } });
  assert.deepEqual(parseStudentSignup({ ageBand: "18+", schoolYear: "y14" }, now), { ok: false, error: "invalid_school_year" });
  assert.deepEqual(parseStudentSignup({ ageBand: "18+", schoolYear: "toString" }, now), { ok: false, error: "invalid_school_year" });
});

test("tutor rules refuse to write coursework, demand real sources and follow the level", () => {
  const gcse = studentTutorRules("y11", "13-17");
  assert.match(gcse, /Never write coursework/);
  assert.match(gcse, /Sources/);
  assert.match(gcse, /never invent a source/);
  assert.match(gcse, /GCSE level/);
  assert.match(gcse, /under 18/);
  assert.match(studentTutorRules("y13", "18+"), /A-level/);
  assert.match(studentTutorRules(undefined, undefined), /GCSE level unless/);
});
