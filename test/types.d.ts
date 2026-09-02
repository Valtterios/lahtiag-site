// Makes the `cloudflare:test` module (from @cloudflare/vitest-plugin) and
// the test environment's bindings visible to the type checker. The plugin
// types the env as `Cloudflare.Env`, a namespace it expects the project to
// declare — normally via `wrangler types`; declared by hand here because
// this project's checked-in types are hand-written (see src/env.d.ts).
/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    DB: import('@cloudflare/workers-types').D1Database;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
