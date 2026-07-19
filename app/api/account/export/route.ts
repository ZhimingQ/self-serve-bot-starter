import { NextResponse } from "next/server";
import { getSession } from "../../../../lib/session";
import { getStore } from "../../../../lib/store";
import { paymentsEnabled, stripe } from "../../../../lib/config";
import { rateLimit } from "../../../../lib/rateLimit";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const rl = await rateLimit("account-export", session.userId, 10, 60);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const store = getStore();
  const [user, preferences, conversationHistory] = await Promise.all([
    store.getUserById(session.userId),
    store.getUserPreferences(session.userId),
    store.getUserHistory(session.userId),
  ]);
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const payload = {
    exportedAt: new Date().toISOString(),
    scope: "Customer storefront account, assistant preferences, and saved conversation history",
    account: {
      email: user.email,
      createdAt: user.createdAt,
      accessStatus: paymentsEnabled ? user.billingStatus ?? "none" : "included",
      billingMode: paymentsEnabled ? stripe.mode : "none",
    },
    assistantPreferences: preferences,
    conversationHistory,
  };
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="customer-workspace-data.json"',
      "Cache-Control": "private, no-store",
    },
  });
}
