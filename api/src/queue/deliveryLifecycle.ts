import { Prisma } from "@prisma/client";
import { prisma } from "../db";

/**
 * Atomically claim one durable delivery run/attempt before any network side effect.
 * Only one worker can transition the expected PENDING/RETRYING row to PROCESSING.
 */
export async function claimDeliveryAttempt(
  deliveryId: string,
  runNumber: number,
  attemptNumber: number,
  client: Pick<Prisma.TransactionClient, "delivery"> = prisma,
  now = new Date()
): Promise<boolean> {
  const claimed = await client.delivery.updateMany({
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
      responseStatus: null,
      responseBodySnippet: null,
      errorMessage: null,
    },
  });

  return claimed.count === 1;
}
