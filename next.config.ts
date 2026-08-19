import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack needs to know that pdfjs-dist/build/pdf.worker.min.mjs is an
  // external asset so it doesn't try to bundle it.
  turbopack: {
    resolveAlias: {
      canvas: "./empty-module.js",
    },
  },
  webpack: (config) => {
    // Prevent webpack from trying to bundle the canvas polyfill (not needed in browser)
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
