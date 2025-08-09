import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce .next/standalone for minimal production bundle used in Dockerfile
  output: "standalone",
  // (Optional) disable lint errors from failing production build; uncomment if needed
  // eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
