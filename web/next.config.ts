import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  turbopack: { root: import.meta.dirname },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/fonts/:asset([a-f0-9]{64}\\.woff2)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default config;
