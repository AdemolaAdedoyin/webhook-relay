import IORedis from "ioredis";
import { config } from "../config";

// BullMQ requires maxRetriesPerRequest: null on the connection it manages.
export const redisConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});
