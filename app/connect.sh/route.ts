import { connectScript } from "../../lib/connectScript";

export const dynamic = "force-dynamic";

export function GET() {
  return connectScript("connect.sh");
}
