const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This template lives nested inside the openclawlaunch monorepo for
  // distribution, but is fully standalone. Pin the tracing root to this
  // directory so Next doesn't get confused by the parent repo's lockfile.
  outputFileTracingRoot: path.join(__dirname),
};

module.exports = nextConfig;
