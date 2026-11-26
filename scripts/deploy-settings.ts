// Run by `pnpm run deploy` before the build. It stops a deploy whose RELEASEBAR_* environment
// variables (Workers Builds build variables) are missing or malformed, and prints the ones that
// vite.config.ts is about to write into the deployed Wrangler config.
import { deployConfig, deploySettingNames } from "../shared/deploy-config.ts";

deployConfig({}, process.env);

const applied = deploySettingNames.filter((name) => process.env[name]?.trim());
console.log(`deploying with ${applied.join(", ")}`);
