// Run by `pnpm run lint`. Fails when code outside worker/store/ names a binding of wrangler.jsonc:
// only the store layer reads or writes KV, D1, the queue, the assets or a Durable Object, so that
// what is behind a store function can change without touching its callers.
//
// The check is on the name, as a whole word, anywhere in a file: in code, in a string, in a
// comment. That is stricter than "no `env.NAME`", and it can't be got around by destructuring
// the env or passing a binding on.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "..");

// Where the Worker's code and the code it shares with the app and the scripts live.
const checkedFolders = ["worker/", "shared/", "src/"];
const storeFolder = "worker/store/";
const exempt = new Set([
  // Writes a deployment's resource IDs into the Wrangler config, by binding name.
  "shared/deploy-config.ts",
]);
const checkedExtensions = [".ts", ".svelte"];

// A binding in wrangler.jsonc: matches `"binding": "DASHBOARD_CACHE"` and, for a Durable Object,
// `"name": "SUMMARY_QUOTA"`; rejects `"name": "releasebar"` and `"class_name": "SummaryQuota"`.
// https://regex101.com/?regex=%22%28%3F%3Abinding%7Cname%29%22%3A%5Cs*%22%28%5BA-Z%5D%5BA-Z%5Cd_%5D*%29%22&flags=g&testString=%7B%20%22name%22%3A%20%22SUMMARY_QUOTA%22%2C%20%22class_name%22%3A%20%22SummaryQuota%22%20%7D
const bindingPattern = /"(?:binding|name)":\s*"([A-Z][A-Z\d_]*)"/g;

async function bindingNames(): Promise<string[]> {
  const config = await readFile(join(root, "wrangler.jsonc"), "utf8");
  return [...new Set([...config.matchAll(bindingPattern)].map((match) => match[1] ?? ""))];
}

async function checkedFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...checkedFolders],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter(
      (name) =>
        name &&
        !name.startsWith(storeFolder) &&
        !name.endsWith(".d.ts") &&
        !exempt.has(name) &&
        checkedExtensions.some((extension) => name.endsWith(extension)),
    );
}

const names = await bindingNames();
// The config must have yielded the bindings, or the check would pass by finding nothing to look for.
for (const expected of ["ASSETS", "DASHBOARD_CACHE", "DB", "REFRESH_QUEUE", "BUILD_COORDINATOR"]) {
  if (!names.includes(expected)) {
    throw new Error(`wrangler.jsonc: binding ${expected} not found; found ${names.join(", ")}`);
  }
}
const namePattern = new RegExp(String.raw`\b(?:${names.join("|")})\b`, "g");

const violations: string[] = [];
for (const name of await checkedFiles()) {
  let source: string;
  try {
    source = await readFile(join(root, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    throw error;
  }
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(namePattern)) {
      violations.push(`${name}:${index + 1}: ${match[0]}`);
    }
  });
}

if (violations.length > 0) {
  for (const violation of violations) console.error(violation);
  console.error(
    `\nOnly ${storeFolder} may name a binding (${names.join(", ")}). ` +
      "Call a function of the store layer, or add one.",
  );
  process.exitCode = 1;
} else {
  console.log(`No binding is named outside ${storeFolder} (${names.length} bindings).`);
}
