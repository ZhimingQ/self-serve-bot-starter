import assert from "node:assert/strict";
import test from "node:test";
import { parseStudentSignup, studentTutorRules } from "./studentTutor.ts";

const now = new Date("2026-10-22T10:00:00.000Z");

test("sign-up records when the terms were confirmed, and asks no age", () => {
  assert.deepEqual(parseStudentSignup({}, now), { ok: true, profile: { termsConfirmedAt: "2026-10-22T10:00:00.000Z" } });
  // An old form still sending an age band is accepted; the band is not stored.
  assert.deepEqual(parseStudentSignup({ ageBand: "18+", guardianConsent: false }, now), {
    ok: true,
    profile: { termsConfirmedAt: "2026-10-22T10:00:00.000Z" },
  });
});

test("school year is optional but must be a known one", () => {
  assert.deepEqual(parseStudentSignup({ schoolYear: "y11" }, now), {
    ok: true,
    profile: { termsConfirmedAt: "2026-10-22T10:00:00.000Z", schoolYear: "y11" },
  });
  assert.deepEqual(parseStudentSignup({ schoolYear: "" }, now), { ok: true, profile: { termsConfirmedAt: "2026-10-22T10:00:00.000Z" } });
  assert.deepEqual(parseStudentSignup({ schoolYear: "y14" }, now), { ok: false, error: "invalid_school_year" });
  assert.deepEqual(parseStudentSignup({ schoolYear: "toString" }, now), { ok: false, error: "invalid_school_year" });
});

test("tutor rules refuse to write coursework, demand real sources and follow the level", () => {
  const gcse = studentTutorRules("y11");
  assert.match(gcse, /Never write coursework/);
  assert.match(gcse, /Sources/);
  assert.match(gcse, /never invent a source/);
  assert.match(gcse, /GCSE level/);
  assert.match(studentTutorRules("y13"), /A-level/);
  assert.match(studentTutorRules(undefined), /GCSE level unless/);
});

test("every student is treated as possibly under 18, whatever they claim", () => {
  for (const year of [undefined, "y9", "y13", "other"]) {
    assert.match(studentTutorRules(year), /may be under 18/);
  }
});
