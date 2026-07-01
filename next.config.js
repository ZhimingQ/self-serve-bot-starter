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
};

module.exports = nextConfig;
