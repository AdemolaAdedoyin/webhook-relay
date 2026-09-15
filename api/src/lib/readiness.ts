import IORedis from "ioredis";
import { prisma } from "../db";
import { config } from "../config";

export async function probeRedis() {
  // Never use the worker's unbounded retry/offline queue for readiness probes.
  const client = new IORedis(config.REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
    connectTimeout: 1000, commandTimeout: 1000, retryStrategy: () => null,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    if (await client.ping() !== "PONG") throw new Error("Redis unavailable");
  } finally { client.disconnect(); }
}

/** One outstanding probe per dependency; timed-out DB work cannot accumulate. */
export function createReadinessProbe(database: () => Promise<unknown>, redis: () => Promise<unknown>, timeoutMs = 1500) {
  const pending = new Map<string, Promise<boolean>>();
  async function check(name: string, probe: () => Promise<unknown>) {
    let operation = pending.get(name);
    if (!operation) {
      operation = Promise.resolve().then(probe).then(() => true, () => false)
        .finally(() => { pending.delete(name); });
      pending.set(name, operation);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return async () => {
    const [postgres, redisOk] = await Promise.all([check("postgres", database), check("redis", redis)]);
    return { status: postgres && redisOk ? "ready" : "not_ready", checks: { postgres, redis: redisOk } };
  };
}

export const checkReadiness = createReadinessProbe(() => prisma.$queryRaw`SELECT 1`, probeRedis);
