import { NextResponse } from "next/server";
import { brand, workspaceMode } from "../../../lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    // workspaceModes lists every WORKSPACE_MODE this build understands, so the
    // platform can tell a build that predates the student website (which would
    // read "students" as "simple") from one that has it.
    { ok: true, brandingRevision: brand.revision, brandName: brand.name, workspaceMode, workspaceModes: ["full", "simple", "students"] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
