import type { NextConfig } from "next";
// node:fs here is fine: next.config.ts is evaluated at build time in Node,
// not inside the Cloudflare Worker.
import { readFileSync } from "fs";
import { join } from "path";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Makes `next dev` aware of the Cloudflare bindings/vars in wrangler.jsonc
// (no-op during `next build`).
void initOpenNextCloudflareForDev();

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  allowedDevOrigins: ['192.168.*.*'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
