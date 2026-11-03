import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": resolve(import.meta.dirname, "test/cloudflare-workers.ts") },
  },
  // Bundle the OAuth library through Vite so the alias above reaches its import.
  test: { server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } } },
});
