import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export interface DeliveryJobData {
  deliveryId: string;
}

export const DELIVERY_QUEUE_NAME = "webhook-deliveries";

export const deliveryQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // We manage attempt bookkeeping ourselves in Postgres (so the dashboard
    // has a durable audit trail independent of Redis), so BullMQ itself only
    // needs to try once per enqueue; retries are re-enqueued explicitly by
    // the worker with a computed backoff delay.
    attempts: 1,
    removeOnComplete: { age: 3600 }, // keep 1h of history in Redis for debugging
    removeOnFail: { age: 24 * 3600 },
  },
});

/** Exponential backoff with jitter, capped at 1 hour. Attempt is 1-indexed. */
export function computeBackoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, 60 * 60 * 1000);
  const jitter = Math.random() * base * 0.2;
  return Math.floor(base + jitter);
}

export async function enqueueDelivery(deliveryId: string, delayMs = 0) {
  await deliveryQueue.add(
    "deliver",
    { deliveryId },
    { delay: delayMs, jobId: `delivery:${deliveryId}:${Date.now()}` }
  );
}
