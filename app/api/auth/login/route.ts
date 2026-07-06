import { NextRequest, NextResponse } from "next/server";
import { getStore } from "../../../../lib/store";
import { verifyPassword } from "../../../../lib/password";
import { setSession } from "../../../../lib/session";
import { rateLimit, clientIp } from "../../../../lib/rateLimit";

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

  const store = getStore();
  const user = await store.getUserByEmail(email);
  if (!user) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.passwordHash, user.passwordSalt);
  if (!valid) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await setSession({ userId: user.id, email: user.email });

  return NextResponse.json({ ok: true });
}
