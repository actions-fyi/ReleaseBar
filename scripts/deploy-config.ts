// Writes wrangler.deploy.json: wrangler.toml with this deployment's settings applied from
// environment variables (Workers Builds build variables). `npm run deploy` deploys from it.
import { writeFile } from "node:fs/promises";

import { type RawWranglerConfig, deployConfig, deploySettingNames } from "./lib/deploy-config.js";

type WranglerConfigReader = {
  readonly experimental_readRawConfig: (args: { readonly config: string }) => {
    readonly rawConfig: unknown;
  };
};

const outputPath = "wrangler.deploy.json";
const jsonIndent = 2;
// Loaded by name: Wrangler's own type declarations pull in Miniflare's, which don't type-check here.
const wranglerModule = "wrangler";

const wrangler = (await import(wranglerModule)) as WranglerConfigReader;
const { rawConfig } = wrangler.experimental_readRawConfig({ config: "wrangler.toml" });
const config = deployConfig(rawConfig as RawWranglerConfig, process.env);
await writeFile(outputPath, `${JSON.stringify(config, null, jsonIndent)}\n`);

const applied = deploySettingNames.filter((name) => process.env[name]?.trim());
console.log(
  `wrote ${outputPath} from wrangler.toml with ${applied.length > 0 ? applied.join(", ") : "no deployment settings"}`,
);
