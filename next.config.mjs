import path from "node:path";

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Allow builds to proceed even if ESLint finds issues; linting can still be run manually.
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    config.resolve.alias["@"] = path.resolve(process.cwd(), "src");
    return config;
  },
};

export default nextConfig;
