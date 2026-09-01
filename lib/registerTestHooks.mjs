/**
 * Entry point for `node --import` / `tsx --import`.
 *
 * Both halves are needed. tsx transpiles a `.ts` file to CommonJS and resolves
 * its imports through `Module._resolveFilename`, which never reaches an ESM
 * loader hook — registering only the hook leaves `Cannot find module
 * 'server-only'` exactly where it started. So: the hook covers real ESM
 * (`lib/*.test.mjs` importing `.ts`), and the `_resolveFilename` patch covers
 * everything tsx routes through CJS.
 */
import Module, { register } from "node:module";

import { MARKER_SPECIFIERS, markerStubPath } from "./testHooks.mjs";

register("./testHooks.mjs", import.meta.url);

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, ...rest) {
  if (MARKER_SPECIFIERS.has(request)) return markerStubPath();
  return originalResolveFilename.call(this, request, ...rest);
};
