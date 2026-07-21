import { NextRequest, NextResponse } from "next/server";
import { getStore } from "../../../../lib/store";
import { verifyPassword } from "../../../../lib/password";
import { setSession } from "../../../../lib/session";
import { rateLimit, clientIp, rateLimitIdentity } from "../../../../lib/rateLimit";

// Keep unknown-email requests on the same scrypt path as known users so the
// response time does not disclose which addresses have accounts.
const DUMMY_PASSWORD_HASH = "0".repeat(128);
const DUMMY_PASSWORD_SALT = "0".repeat(32);

export async function POST(request: NextRequest) {
  // Throttle login brute-force per IP (10 attempts / 5 min).
  const rl = await rateLimit("login", clientIp(request), 10, 300);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many login attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;

  if (!email || !password || email.length > 254 || password.length > 200) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  // An IP limiter alone can be evaded with a proxy network. Also cap attempts
  // against the same account, without storing the email itself in Redis keys.
  const emailRl = await rateLimit("login-email", rateLimitIdentity(email), 10, 900);
  if (!emailRl.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many login attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(emailRl.retryAfterSec) } }
    );
  }

  const store = getStore();
  const user = await store.getUserByEmail(email);
  const valid = await verifyPassword(
    password,
    user?.passwordHash || DUMMY_PASSWORD_HASH,
    user?.passwordSalt || DUMMY_PASSWORD_SALT
  );
  if (!user || !valid) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await setSession({ userId: user.id, email: user.email });

  return NextResponse.json({ ok: true });
}
