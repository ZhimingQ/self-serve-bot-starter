import { NextRequest, NextResponse, after } from "next/server";
import { rateLimit, clientIp, rateLimitIdentity } from "../../../../lib/rateLimit";
import { requestPasswordReset, resetEmailConfigured } from "../../../../lib/passwordReset";

/**
 * "I forgot my password" — step 1: mint a token and email it.
 *
 * THE RESPONSE IS DELIBERATELY THE SAME whether or not the address has an
 * account. Answering "no such user" would turn this endpoint into a customer
 * list: anyone could test addresses against a storefront and learn who its
 * customers are. So the browser gets one generic acknowledgement, and the real
 * outcome is only ever visible in the reseller's own server log.
 *
 * The one thing it DOES distinguish is whether this storefront can send email at
 * all. That is a property of the deployment, not of any address, so it leaks
 * nothing about who has an account — and hiding it would strand the customer
 * waiting for a message that was never going to arrive.
 */
export async function POST(request: NextRequest) {
  if (!resetEmailConfigured()) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }

  const ip = clientIp(request);
  // Two buckets: per-IP stops someone walking a list of addresses, per-address
  // stops one customer's inbox being flooded from many IPs.
  const byIp = await rateLimit("forgot-password-ip", ip || "unknown", 10, 3600);
  if (!byIp.ok) return NextResponse.json({ ok: true });

  let body: { email?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ ok: true }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !email.includes("@")) {
    return NextResponse.json({ ok: true });
  }

  // Hashed, like the login path: a rate-limit key should not be a plaintext
  // customer address sitting in Redis.
  const byEmail = await rateLimit("forgot-password-email", rateLimitIdentity(email), 5, 3600);
  if (!byEmail.ok) return NextResponse.json({ ok: true });

  // The mint-and-send runs AFTER the response, and that is a correctness
  // requirement rather than a latency tweak. An identical status and body are not
  // enough to stop enumeration if the two cases take visibly different times to
  // produce: an unknown address returns from a single store read, while a known
  // one performs writes and waits on an HTTP round trip to the mail provider. That
  // gap is tens to hundreds of milliseconds — trivially measurable, and enough to
  // walk a list of addresses and learn which ones are customers. Deferring the
  // whole thing means the response is sent before any of it starts, so both cases
  // cost the same rate-limit check and nothing else.
  //
  // A delivery failure is likewise never reported to the browser. `requestPasswordReset`
  // returns `no_user` without attempting a send, so a send can only fail for an
  // address that DOES have an account — surfacing it would hand back the exact bit
  // this endpoint exists to withhold, and would do so precisely during a provider
  // outage. It goes to the reseller's server log instead, and the acknowledgement
  // the customer sees already points them at support if nothing arrives.
  after(async () => {
    try {
      const outcome = await requestPasswordReset(email);
      if (!outcome.sent && outcome.reason === "send_failed") {
        console.error("[forgot-password] delivery failed for a known address — check RESEND_API_KEY and the sending domain");
      }
    } catch (err) {
      console.error("[forgot-password] failed:", err instanceof Error ? err.message : String(err));
    }
  });

  return NextResponse.json({ ok: true });
}
