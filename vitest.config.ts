import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const tests = "test";

// Tests that need Node.js. Every other test file runs inside the Workers runtime.
const nodeTests = [
  // Reads Svelte component sources from disk.
  `${tests}/routing-view.test.ts`,
];

// The SQL files of migrations/, which test/reset-storage.ts applies to the local D1 database
// before each test.
const d1Migrations = await readD1Migrations("migrations");

export default defineConfig({
  test: {
    // Print what a test logs only when it fails: the Worker logs every audit event.
    silent: "passed-only",
    // node:test, which ran these tests before, had no timeout, and the slowest test waits out
    // about five seconds of the Worker's own retry delays: Vitest's default of 5 seconds is too
    // close to that.
    testTimeout: 30_000,
    coverage: {
      // The Workers runtime has no V8 coverage: the code is instrumented instead.
      provider: "istanbul",
      include: ["scripts/**/*.ts", "shared/**/*.ts", "src/**/*.ts", "worker/**/*.ts"],
      exclude: ["**/*.d.ts"],
      reporter: ["text-summary", "cobertura"],
    },
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { TEST_D1_MIGRATIONS: d1Migrations } },
          }),
        ],
        test: {
          name: "workers",
          include: [`${tests}/*.test.ts`],
          exclude: nodeTests,
          setupFiles: [`${tests}/reset-storage.ts`],
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
