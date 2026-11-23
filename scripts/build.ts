// Fetches the dashboard data of releasebar.config.json from GitHub. `npm run build:data` writes
// it next to the built app; `npm run check:data` only prints the totals.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDashboard, normalizeBuildOptions } from "../shared/dashboard.ts";
import type { ReleaseBarConfig } from "../src/types.ts";

const root = process.cwd();
const dataDir = path.join(root, "dist", "client", "data");
const configPath = path.join(root, "releasebar.config.json");
const checkOnly = process.argv.includes("--check");

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8")) as ReleaseBarConfig;
  const payload = await buildDashboard(
    normalizeBuildOptions(config, {
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
      ...(process.env.RELEASEBAR_DOMAIN?.trim()
        ? { canonicalDomain: process.env.RELEASEBAR_DOMAIN.trim() }
        : {}),
      log: (message) => process.stdout.write(`${message}\n`),
    }),
  );

  if (checkOnly) {
    console.log(JSON.stringify(payload.totals, null, 2));
    return;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "projects.json"), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`built ${payload.projects.length} projects at ${payload.generatedAt}`);
}

await main();
