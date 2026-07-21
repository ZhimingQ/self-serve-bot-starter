import { NextResponse } from "next/server";
import { brand } from "../../../lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { ok: true, brandingRevision: brand.revision, brandName: brand.name },
    { headers: { "Cache-Control": "no-store" } },
  );
}
