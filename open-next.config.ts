import { defineCloudflareConfig } from "@opennextjs/cloudflare";

const config = {
  ...defineCloudflareConfig({
    // No incremental/tag cache needed: the app is a fully client-side shell
    // (all /api routes were removed; the agent backend is a separate Worker).
  }),
  // The repo builds with webpack (see package.json "build"); keep OpenNext's
  // internal `next build` invocation consistent with that.
  buildCommand: "npx next build --webpack",
};

export default config;
