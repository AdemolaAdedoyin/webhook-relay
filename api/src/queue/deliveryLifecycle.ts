import { prisma } from "../db";

/**
 * Atomically claim one durable delivery run/attempt before any network side effect.
 * Only one worker can transition the expected PENDING/RETRYING row to PROCESSING.
 */
export async function claimDeliveryAttempt(
  deliveryId: string,
  runNumber: number,
  attemptNumber: number
): Promise<boolean> {
  const now = new Date();
  const claimed = await prisma.delivery.updateMany({
    where: {
      id: deliveryId,
      runNumber,
      attemptCount: attemptNumber - 1,
      status: { in: ["PENDING", "RETRYING"] },
    },
    data: {
      status: "PROCESSING",
      attemptCount: attemptNumber,
      lastAttemptAt: now,
      processingHeartbeatAt: now,
      nextAttemptAt: null,
    },
  });

  return claimed.count === 1;
}
