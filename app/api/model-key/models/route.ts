import { allowEndUserByok, brand } from "../../../../lib/config";
import { hermesListModels } from "../../../../lib/hermesModelKeyApi";
import { NextResponse } from "next/server";

/** Hermes "your own API key" panel: which models a key can use. See
 *  lib/hermesModelKeyApi.ts. 404 when the panel is not offered. */
export async function POST(request: Request) {
  if (!allowEndUserByok || brand.framework !== "hermes") return NextResponse.json({ error: "not_found" }, { status: 404 });
  return hermesListModels(request);
}
