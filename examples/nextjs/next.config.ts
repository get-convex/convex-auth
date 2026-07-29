import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // TODO: dowski - update the Convex Auth build process so consumers don't have to do this
  transpilePackages: ["@convex-dev/auth"],
};

export default nextConfig;
