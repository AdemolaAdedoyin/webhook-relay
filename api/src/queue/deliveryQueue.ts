import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export interface DeliveryJobData {
  deliveryId: string;
  attemptNumber: number;
}

export const DELIVERY_QUEUE_NAME = "webhook-deliveries";

export const deliveryQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Delivery retries are durable in Postgres. BullMQ executes one queue job
    // per durable attempt and retry scheduling creates the next deterministic
    // attempt projection explicitly.
    attempts: 1,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 24 * 3600 },
  },
});

/** Exponential backoff with jitter, capped at 1 hour. Attempt is 1-indexed. */
export function computeBackoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 1000, 60 * 60 * 1000);
  const jitter = Math.random() * base * 0.2;
  return Math.floor(base + jitter);
}

export function deliveryJobId(deliveryId: string, attemptNumber: number) {
  return `delivery-${deliveryId}-attempt-${attemptNumber}`;
}

/**
 * Ensure one BullMQ projection exists for a durable delivery attempt.
 *
 * The deterministic ID makes retries of the projection write safe. A failed
 * or completed Redis job may be removed and rebuilt only when Postgres still
 * says that same attempt is pending, while active/waiting/delayed jobs are
 * left untouched.
 */
export async function enqueueDelivery(
  deliveryId: string,
  attemptNumber: number,
  delayMs = 0
) {
  const jobId = deliveryJobId(deliveryId, attemptNumber);
  const existing = await deliveryQueue.getJob(jobId);

  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") {
      try {
        await existing.remove();
      } catch {
        // Another reconciler may have repaired the same deterministic job.
      }

      const repaired = await deliveryQueue.getJob(jobId);
      if (repaired) return repaired;
    } else {
      return existing;
    }
  }

  return deliveryQueue.add(
    "deliver",
    { deliveryId, attemptNumber },
    {
      delay: Math.max(0, delayMs),
      jobId,
    }
  );
}
