import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const tests = "scripts/lib/dashboard-tests";

// Tests that need Node.js. Every other test file runs inside the Workers runtime.
const nodeTests = [
  // Reads Svelte component sources from disk.
  `${tests}/routing-view.test.ts`,
  // Renders a PNG through the Worker's Node.js branch, which compiles the renderer's WebAssembly
  // from bytes. The Workers runtime refuses that; a deployed Worker imports the module instead.
  `${tests}/social-cards.test.ts`,
];

export default defineConfig({
  test: {
    // Print what a test logs only when it fails: the Worker logs every audit event.
    silent: "passed-only",
    coverage: {
      // The Workers runtime has no V8 coverage: the code is instrumented instead.
      provider: "istanbul",
      include: ["scripts/**/*.ts", "src/**/*.ts", "worker/**/*.ts"],
      exclude: [`${tests}/**`, "scripts/lib/dashboard-test-harness.ts", "**/*.d.ts"],
      reporter: ["text-summary", "cobertura"],
    },
    projects: [
      {
        plugins: [
          cloudflareTest({
            // The TypeScript source, not the compiled entry point the Wrangler configuration names.
            main: "./worker/index.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
          }),
        ],
        test: {
          name: "workers",
          include: [`${tests}/**/*.test.ts`],
          exclude: nodeTests,
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: nodeTests,
        },
      },
    ],
  },
});
