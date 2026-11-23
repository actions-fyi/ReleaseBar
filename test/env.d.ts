// Bindings that exist only in the tests: vitest.config.ts adds them to the Workers runtime.
declare namespace Cloudflare {
  interface Env {
    // The SQL files of migrations/, for `applyD1Migrations`.
    TEST_D1_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
