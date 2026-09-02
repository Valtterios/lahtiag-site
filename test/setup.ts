import { env, applyD1Migrations } from 'cloudflare:test';

// The production migrations, read by vitest.config.ts in Node and applied
// here inside workerd, so every test file sees the real schema.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
