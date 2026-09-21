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

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGINS: z.string().default("").transform(v => v.split(",").map(s => s.trim()).filter(Boolean)).refine(values => values.every(v => { try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && u.origin === v; } catch { return false; } }), "Use exact http(s) origins without paths"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    LOG_LEVEL: z.string().default("info"),
    SIGNING_SECRET_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[0-9a-fA-F]{64}$/).optional()),
    // Delivery tuning
    DELIVERY_MAX_REPLAYS: z.coerce.number().int().min(0).default(5),
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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.CORS_ORIGINS.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["CORS_ORIGINS"], message: "required in production" });
    if (env.NODE_ENV === "production" && !env.SIGNING_SECRET_KEY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SIGNING_SECRET_KEY"], message: "required in production" });
    }
    if (env.DELIVERY_PROCESSING_STALE_MS <= env.DELIVERY_PROCESSING_HEARTBEAT_MS * 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DELIVERY_PROCESSING_STALE_MS"],
        message: "must be greater than twice DELIVERY_PROCESSING_HEARTBEAT_MS",
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loud: a misconfigured service should never limp along.
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
