import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type Plugin, defineConfig } from "vite";

import { type RawWranglerConfig, deployConfig, hasDeploySettings } from "./shared/deploy-config.ts";

const fontPackage = path.dirname(
  createRequire(import.meta.url).resolve("@fontsource/jetbrains-mono/package.json"),
);

// Files the site serves under fixed names, taken from the font package: the two fonts the Worker
// reads from ASSETS to render social cards (worker/social-card.ts), and the font's license. The
// OFL asks that each copy of the font comes with its license; the font files only link to it.
const fontFiles: Readonly<Record<string, string>> = {
  "jetbrains-mono-latin-400-normal.woff2": "files/jetbrains-mono-latin-400-normal.woff2",
  "jetbrains-mono-latin-700-normal.woff2": "files/jetbrains-mono-latin-700-normal.woff2",
  "jetbrains-mono-LICENSE.txt": "LICENSE",
};

function fontAssets(): Plugin {
  const read = (name: string) => readFile(path.join(fontPackage, fontFiles[name] ?? name));
  return {
    name: "releasebar:font-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = (request.url ?? "").split("?")[0]?.slice(1) ?? "";
        if (!Object.hasOwn(fontFiles, name)) return next();
        read(name).then((body) => {
          response.setHeader("content-type", name.endsWith(".txt") ? "text/plain" : "font/woff2");
          response.end(body);
        }, next);
      });
    },
    async generateBundle() {
      if (this.environment.name !== "client") return;
      for (const name of Object.keys(fontFiles)) {
        this.emitFile({ type: "asset", fileName: name, source: await read(name) });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    svelte(),
    fontAssets(),
    // Builds worker/index.ts, the `main` of wrangler.jsonc, next to the app, and writes the
    // Wrangler config that `wrangler deploy` then reads: dist/releasebar/wrangler.json.
    cloudflare({
      // wrangler.jsonc names no deployment. A deployment's own values come from RELEASEBAR_*
      // environment variables (see docs/self-hosting.md) and are written into the built config.
      config: (config) => {
        // The Worker runs first for every request and answers a path without a file extension
        // with the app shell. On the dev server that would catch Vite's own module URLs, such as
        // /@vite/client, so those go to Vite directly.
        if (command === "serve" && config.assets) {
          config.assets.run_worker_first = ["/*", "!/@vite/*", "!/@id/*", "!/@fs/*"];
        }
        if (!hasDeploySettings(process.env)) return;
        Object.assign(config, deployConfig(config as RawWranglerConfig, process.env));
      },
    }),
  ],
}));
