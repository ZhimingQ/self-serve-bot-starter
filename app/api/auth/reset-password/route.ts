import { NextRequest, NextResponse } from "next/server";
import { hashPassword } from "../../../../lib/password";
import { rateLimit, clientIp } from "../../../../lib/rateLimit";
import { completePasswordReset } from "../../../../lib/passwordReset";

/**
 * "I forgot my password" — step 2: spend the token and set a new password.
 *
 * Deliberately does NOT sign the customer in afterwards. A reset link can sit in
 * an inbox that is itself compromised, or be opened on a shared machine; making
 * them type the new password once at /login is a cheap confirmation that the
 * person who set it is the person using it. `completePasswordReset` also rotates
 * the session version, so every previously issued cookie is dead — including one
 * held by whoever prompted the reset.
 *
 * Password rules match the signup route exactly (8–200 chars). Two different
 * minimums across two entry points is a bug waiting to be filed.
 */
export async function POST(request: NextRequest) {
  const rl = await rateLimit("reset-password", clientIp(request), 20, 3600);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: { token?: unknown; password?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token) return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  if (!password || password.length < 8 || password.length > 200) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  const { hash, salt } = await hashPassword(password);

  try {
    const done = await completePasswordReset(token, hash, salt);
    if (!done) {
      // Unknown, expired, or already spent — one answer for all three, so the
      // endpoint cannot be used to probe which tokens exist.
      return NextResponse.json({ error: "invalid_token" }, { status: 400 });
    }
  } catch (err) {
    console.error("[reset-password] failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "reset_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
