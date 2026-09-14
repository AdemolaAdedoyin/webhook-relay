import "dotenv/config";
import { z } from "zod";

const commaSeparatedHosts = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  LOG_LEVEL: z.string().default("info"),
  // Delivery tuning
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  DELIVERY_PROCESSING_HEARTBEAT_MS: z.coerce.number().int().min(250).default(5_000),
  DELIVERY_PROCESSING_STALE_MS: z.coerce.number().int().min(1_000).default(60_000),
  // Exact hostnames allowed to receive production webhook traffic. Production
  // delivery remains disabled until at least one host is explicitly trusted.
  WEBHOOK_ALLOWED_HOSTS: commaSeparatedHosts,
  // Auto-disable a subscription after N consecutive full-exhaustion failures
  SUBSCRIPTION_AUTO_DISABLE_THRESHOLD: z.coerce.number().int().min(1).default(5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured service should never limp along.
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
