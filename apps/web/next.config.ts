import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@clmm-autopilot/core", "@clmm-autopilot/solana"],
};

export default nextConfig;
