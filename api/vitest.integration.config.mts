import { defineConfig } from "vitest/config";

// Deliberately separate from unit-test defaults and developer databases.
const database = process.env.INTEGRATION_DATABASE_URL;
const redis = process.env.INTEGRATION_REDIS_URL;
if (!database || !redis || !new URL(database).pathname.endsWith("_test") || new URL(redis).pathname !== "/15") {
  throw new Error("Set INTEGRATION_DATABASE_URL to a dedicated *_test database and INTEGRATION_REDIS_URL to a dedicated Redis /15 instance");
}

export default defineConfig({
  test: {
    include: ["integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      DATABASE_URL: database,
      REDIS_URL: redis,
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SIGNING_SECRET_KEY: "ab".repeat(32),
      DELIVERY_PROCESSING_HEARTBEAT_MS: "250",
      DELIVERY_PROCESSING_STALE_MS: "2000",
    },
  },
});
