import { NextResponse } from "next/server";
import { brand, workspaceMode } from "../../../lib/config";
import { linkProxyFields } from "../../../lib/linkProxy";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    // workspaceModes lists every WORKSPACE_MODE this build understands, so the
    // platform can tell a build that predates the student website (which would
    // read "students" as "simple") from one that has it. linkProxy says this build passes /d, the
    // assistant endpoint and the connect scripts through (lib/linkProxy.ts), so
    // the platform may hand customers links on this domain; linkProxyKey proves
    // which reseller key it runs with.
    { ok: true, brandingRevision: brand.revision, brandName: brand.name, workspaceMode, workspaceModes: ["full", "simple", "students"], ...linkProxyFields() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
