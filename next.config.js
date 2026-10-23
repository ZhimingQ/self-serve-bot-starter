const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This template lives nested inside the openclawlaunch monorepo for
  // distribution, but is fully standalone. Pin the tracing root to this
  // directory so Next doesn't get confused by the parent repo's lockfile.
  outputFileTracingRoot: path.join(__dirname),
  // This is a starter that resellers are expected to edit, and it's built
  // unattended (Vercel, or in-container via "Deploy via your bot"). A stray
  // lint warning shouldn't fail the build; TypeScript type-checking still runs.
  eslint: { ignoreDuringBuilds: true },
  // Opt-in standalone output, set ONLY by scripts/build-storefront-artifact.sh
  // when OpenClaw Launch prebuilds this template centrally for "Deploy via your
  // bot". Left off by default so a reseller's own `next build` — locally, or on
  // Vercel, which supplies its own output handling — behaves exactly as a stock
  // Next app. Note a standalone build's server.js does NOT read .env at runtime;
  // the prebuilt deploy path ships a start.js wrapper that loads it first.
  ...(process.env.STOREFRONT_STANDALONE === "1" ? { output: "standalone" } : {}),
  // Set only by scripts/rebuild-from-source.sh, which builds inside the owner's
  // bot container. Next sizes its build workers from os.cpus(), which there is
  // the HOST's core count, and those workers drop the heap cap: one worker keeps
  // the build inside the memory the bot can spare.
  ...(process.env.STOREFRONT_BUILD_CPUS
    ? { experimental: { cpus: Math.max(1, Number(process.env.STOREFRONT_BUILD_CPUS) || 1) } }
    : {}),
};

module.exports = nextConfig;
