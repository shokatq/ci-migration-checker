import type { NextConfig } from "next";

// Static export: the whole app runs in the browser, so it can be hosted on
// Vercel, GitLab Pages or any static host. See "Design decisions" in README.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
