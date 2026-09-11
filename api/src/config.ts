import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  LOG_LEVEL: z.string().default("info"),
  // Delivery tuning
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().default(8),
  DELIVERY_TIMEOUT_MS: z.coerce.number().default(10_000),
  DELIVERY_CONCURRENCY: z.coerce.number().default(10),
  // Auto-disable a subscription after N consecutive full-exhaustion failures
  SUBSCRIPTION_AUTO_DISABLE_THRESHOLD: z.coerce.number().default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured service should never limp along.
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
