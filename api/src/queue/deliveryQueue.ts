import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export interface DeliveryJobData {
  deliveryId: string;
  runNumber: number;
  attemptNumber: number;
}

export const DELIVERY_QUEUE_NAME = "webhook-deliveries";

export const deliveryQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    // Delivery retries are durable in Postgres. BullMQ executes one queue job
    // per durable run/attempt and retry scheduling creates the next deterministic
    // projection explicitly.
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

export function deliveryJobId(deliveryId: string, runNumber: number, attemptNumber: number) {
  return `delivery-${deliveryId}-run-${runNumber}-attempt-${attemptNumber}`;
}

/** Ensure one BullMQ projection exists for the current durable delivery run/attempt. */
export async function enqueueDelivery(
  deliveryId: string,
  runNumber: number,
  attemptNumber: number,
  delayMs = 0
) {
  const jobId = deliveryJobId(deliveryId, runNumber, attemptNumber);
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
    { deliveryId, runNumber, attemptNumber },
    {
      delay: Math.max(0, delayMs),
      jobId,
    }
  );
}
