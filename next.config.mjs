/** @type {import("next").NextConfig} */
const nextConfig = {
  // Allow builds to proceed even if ESLint finds issues; linting can still be run manually.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
