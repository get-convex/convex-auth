import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@convex-dev/auth` ships raw TypeScript, so Next must transpile it.
  transpilePackages: ["@convex-dev/auth"],
};

export default nextConfig;
