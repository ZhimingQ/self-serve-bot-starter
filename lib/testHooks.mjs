/**
 * Test-only resolution of the `server-only` / `client-only` markers.
 *
 * Those specifiers are not real dependencies of this template — Next aliases
 * them internally during a build, so `import "server-only"` compiles fine but
 * cannot be resolved by plain node or tsx. Without this, every module carrying
 * the marker (lib/passwordReset.ts, lib/billing.ts, lib/buildResell.ts) is
 * untestable, which is a bad trade: the marker is what keeps secrets out of
 * client bundles, and deleting it to gain tests would remove the guard it
 * documents.
 *
 * This is deliberately NOT a `paths` entry in tsconfig.json. tsx honours those,
 * but so does the Next build — a mapping there would shadow Next's own alias and
 * resolve the marker to a harmless no-op in CLIENT bundles too, silently
 * disabling the protection everywhere. Keeping it in a `--import` hook means it
 * exists only inside `npm run test:*`.
 *
 * The target is the package's `empty.js`, NOT `index.js`. `index.js` throws on
 * import ("cannot be imported from a Client Component") — that throw IS the
 * guard. `empty.js` is the same package's server-side branch and is a no-op,
 * which is the correct resolution for a test process that IS the server.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export const MARKER_SPECIFIERS = new Set(["server-only", "client-only"]);

let cached = null;

/** Absolute path to Next's vendored no-op marker module. */
export function markerStubPath() {
  if (!cached) {
    // Resolve through `next` itself so this survives the vendored path moving.
    const nextPkg = require.resolve("next/package.json");
    cached = path.join(path.dirname(nextPkg), "dist", "compiled", "server-only", "empty.js");
  }
  return cached;
}

export async function resolve(specifier, context, nextResolve) {
  if (MARKER_SPECIFIERS.has(specifier)) {
    return { url: pathToFileURL(markerStubPath()).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
