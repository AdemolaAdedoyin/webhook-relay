import { prisma } from "../db";
import { claimDeliveryAttempt } from "./deliveryLifecycle";

type Admission = { status: "claimed" | "skipped" } | { status: "deferred"; retryAt: Date };

/** Serialize admission per subscription across processes using a durable row lock. */
export async function admitDeliveryAttempt(
  subscriptionId: string, deliveryId: string, runNumber: number, attemptNumber: number
): Promise<Admission> {
  return prisma.$transaction(async (tx): Promise<Admission> => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Subscription" WHERE id = ${subscriptionId} FOR UPDATE`;
    if (!locked.length) return { status: "skipped" };
    const subscription = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    const delivery = await tx.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || delivery.subscriptionId !== subscriptionId || delivery.runNumber !== runNumber ||
        delivery.attemptCount !== attemptNumber - 1 || !["PENDING", "RETRYING"].includes(delivery.status)) {
      return { status: "skipped" };
    }
    if (subscription.archivedAt) {
      await tx.delivery.update({ where: { id: deliveryId }, data: { status: "CANCELLED", nextAttemptAt: null, errorMessage: "Subscription archived" } });
      return { status: "skipped" };
    }
    // Leave paused work durable and unconsumed. Reconciliation picks it up on resume.
    if (subscription.status === "PAUSED") return { status: "skipped" };
    if (subscription.status !== "ACTIVE") {
      await tx.delivery.update({ where: { id: deliveryId }, data: {
        status: "FAILED", nextAttemptAt: null, errorMessage: "Subscription disabled",
      } });
      return { status: "skipped" };
    }
    // Read the database clock *after* obtaining the lock, avoiding host skew and
    // timestamps captured before waiting for another transaction.
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = clock!.now;
    const active = await tx.delivery.count({ where: { subscriptionId, status: "PROCESSING" } });
    const next = Math.max(
      delivery.nextAttemptAt?.getTime() ?? 0,
      subscription.nextDeliveryAllowedAt?.getTime() ?? 0,
      active >= subscription.maxConcurrentDeliveries ? now.getTime() + 1000 : 0
    );
    if (next > now.getTime()) {
      const retryAt = new Date(next);
      await tx.delivery.update({ where: { id: deliveryId }, data: { nextAttemptAt: retryAt } });
      return { status: "deferred", retryAt };
    }
    const claimed = await claimDeliveryAttempt(deliveryId, runNumber, attemptNumber, tx, now);
    if (!claimed) return { status: "skipped" };
    await tx.subscription.update({ where: { id: subscriptionId }, data: {
      nextDeliveryAllowedAt: new Date(now.getTime() + subscription.minDeliveryIntervalMs),
    } });
    return { status: "claimed" };
  });
}
