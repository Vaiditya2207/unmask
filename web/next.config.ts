import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  reactStrictMode: true,
};

export default config;
