import { Worker, Job, DelayedError } from "bullmq";
import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { assertSafeWebhookUrl, readResponseSnippet } from "../lib/network";
import { revealSecret } from "../lib/secretEncryption";
import { signPayload } from "../lib/signature";
import { redisConnection } from "./connection";
import {
  DELIVERY_QUEUE_NAME,
  DeliveryJobData,
  computeBackoffMs,
  deliveryQueue,
  enqueueDelivery,
} from "./deliveryQueue";
import { admitDeliveryAttempt } from "./subscriptionThroughput";
import { recoverStaleProcessingDeliveries, refreshProcessingLease } from "./processingRecovery";
import { reconcilePendingDeliveries } from "./reconcile";
import { startMaintenanceLoop } from "./maintenanceLoop";

const MAX_RESPONSE_SNIPPET_BYTES = 2000;
const RECONCILE_INTERVAL_MS = 30_000;

function startLeaseRefresh(deliveryId: string, runNumber: number, attemptNumber: number) {
  const timer = setInterval(() => {
    void refreshProcessingLease(deliveryId, runNumber, attemptNumber).catch((error) => {
      logger.warn(
        { err: error, deliveryId, runNumber, attemptNumber },
        "failed to refresh delivery processing lease"
      );
    });
  }, config.DELIVERY_PROCESSING_HEARTBEAT_MS);
  timer.unref();
  return timer;
}

/**
 * Performs one delivery attempt. The durable row is atomically claimed before
 * any network side effect so duplicate BullMQ projections/workers cannot send
 * the same run/attempt concurrently.
 */
async function processDelivery(job: Job<DeliveryJobData>, token?: string) {
  const { deliveryId, runNumber, attemptNumber } = job.data;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: true, subscription: true },
  });

  if (!delivery) {
    logger.warn({ deliveryId }, "delivery not found, skipping (likely deleted)");
    return;
  }

  const expectedAttempt = delivery.attemptCount + 1;
  if (
    runNumber !== delivery.runNumber ||
    attemptNumber !== expectedAttempt ||
    (delivery.status !== "PENDING" && delivery.status !== "RETRYING")
  ) {
    logger.info(
      {
        deliveryId,
        runNumber,
        currentRunNumber: delivery.runNumber,
        attemptNumber,
        expectedAttempt,
        status: delivery.status,
      },
      "skipping stale or already-claimed delivery queue projection"
    );
    return;
  }

  const admission = await admitDeliveryAttempt(delivery.subscriptionId, deliveryId, runNumber, attemptNumber);
  if (admission.status === "deferred") {
    // Durable nextAttemptAt was persisted first. If Redis fails here, normal
    // reconciliation repairs this same run/attempt without consuming a retry.
    await job.moveToDelayed(admission.retryAt.getTime(), token);
    throw new DelayedError();
  }
  if (admission.status === "skipped") {
    logger.info({ deliveryId, runNumber, attemptNumber }, "delivery attempt was claimed elsewhere");
    return;
  }

  const leaseTimer = startLeaseRefresh(deliveryId, runNumber, attemptNumber);

  try {
    // Admission checked current subscription status under its row lock.
    // A pause after that claim lets this in-flight attempt finish.
    const rawBody = JSON.stringify({
      id: delivery.event.id,
      type: delivery.event.type,
      createdAt: delivery.event.createdAt,
      data: delivery.event.payload,
    });
    const timestamp = Date.now();
    let signature = signPayload(rawBody, revealSecret(delivery.subscription.secret, delivery.subscriptionId), timestamp);
    if (delivery.subscription.previousSecret && delivery.subscription.previousSecretExpiresAt && delivery.subscription.previousSecretExpiresAt.getTime() > timestamp) {
      const previous = signPayload(rawBody, revealSecret(delivery.subscription.previousSecret, delivery.subscriptionId), timestamp);
      signature += `,${previous.split(",")[1]}`;
    }

    const startedAt = Date.now();
    let responseStatus: number | null = null;
    let responseBodySnippet: string | null = null;
    let errorMessage: string | null = null;
    let succeeded = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.DELIVERY_TIMEOUT_MS);

    try {
      const target = await assertSafeWebhookUrl(delivery.subscription.targetUrl);

      const res = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Webhook-Signature": signature,
          "Webhook-Event-Type": delivery.event.type,
          "Webhook-Delivery-Id": delivery.id,
          "Webhook-Delivery-Run": String(runNumber),
          "User-Agent": "webhook-relay/1.0",
        },
        body: rawBody,
        signal: controller.signal,
        redirect: "manual",
      });

      responseStatus = res.status;
      responseBodySnippet = await readResponseSnippet(res, MAX_RESPONSE_SNIPPET_BYTES).catch(() => "");

      if (res.status >= 300 && res.status < 400) {
        errorMessage = `Endpoint redirect HTTP ${res.status} is not allowed`;
      } else {
        succeeded = res.status >= 200 && res.status < 300;
        if (!succeeded) {
          errorMessage = `Endpoint responded with HTTP ${res.status}`;
        }
      }
    } catch (err: any) {
      errorMessage = err?.name === "AbortError" ? "Request timed out" : err?.message ?? "Unknown network error";
    } finally {
      clearTimeout(timeout);
    }

    const durationMs = Date.now() - startedAt;

    await prisma.deliveryAttempt.create({
      data: {
        deliveryId: delivery.id,
        runNumber,
        attemptNumber,
        durationMs,
        responseStatus,
        responseBodySnippet,
        errorMessage,
      },
    });

    if (succeeded) {
      const finalized = await prisma.$transaction(async (tx) => {
        const updated = await tx.delivery.updateMany({
          where: {
            id: delivery.id,
            runNumber,
            attemptCount: attemptNumber,
            status: "PROCESSING",
          },
          data: {
            status: "SUCCEEDED",
            processingHeartbeatAt: null,
            nextAttemptAt: null,
            responseStatus,
            responseBodySnippet,
            errorMessage: null,
          },
        });

        if (updated.count !== 1) return false;

        await tx.subscription.update({
          where: { id: delivery.subscriptionId },
          data: { consecutiveFailures: 0 },
        });
        return true;
      });

      if (finalized) {
        logger.info({ deliveryId, runNumber, attemptNumber, durationMs }, "delivery succeeded");
      }
      return;
    }

    const exhausted = attemptNumber >= delivery.maxAttempts;

    if (exhausted) {
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.delivery.updateMany({
          where: {
            id: delivery.id,
            runNumber,
            attemptCount: attemptNumber,
            status: "PROCESSING",
          },
          data: {
            status: "FAILED",
            processingHeartbeatAt: null,
            nextAttemptAt: null,
            responseStatus,
            responseBodySnippet,
            errorMessage,
          },
        });

        if (updated.count !== 1) return { finalized: false, shouldDisable: false };

        const subscription = await tx.subscription.update({
          where: { id: delivery.subscriptionId },
          data: { consecutiveFailures: { increment: 1 } },
        });
        const shouldDisable =
          subscription.status === "ACTIVE" &&
          subscription.consecutiveFailures >= config.SUBSCRIPTION_AUTO_DISABLE_THRESHOLD;

        if (shouldDisable) {
          await tx.subscription.update({
            where: { id: delivery.subscriptionId },
            data: { status: "DISABLED" },
          });
        }

        return { finalized: true, shouldDisable };
      });

      if (result.finalized) {
        logger.warn(
          { deliveryId, runNumber, attemptNumber, shouldDisable: result.shouldDisable },
          "delivery exhausted all attempts"
        );
      }
      return;
    }

    const delay = computeBackoffMs(attemptNumber);
    const nextAttemptAt = new Date(Date.now() + delay);
    const released = await prisma.delivery.updateMany({
      where: {
        id: delivery.id,
        runNumber,
        attemptCount: attemptNumber,
        status: "PROCESSING",
      },
      data: {
        status: "RETRYING",
        processingHeartbeatAt: null,
        nextAttemptAt,
        responseStatus,
        responseBodySnippet,
        errorMessage,
      },
    });

    if (released.count !== 1) return;

    try {
      await enqueueDelivery(delivery.id, runNumber, attemptNumber + 1, delay);
    } catch (error) {
      logger.warn(
        { err: error, deliveryId, runNumber, attemptNumber: attemptNumber + 1 },
        "retry persisted but queue projection failed; reconciliation will repair it"
      );
    }

    logger.info({ deliveryId, runNumber, attemptNumber, nextAttemptAt }, "delivery scheduled for retry");
  } finally {
    clearInterval(leaseTimer);
  }
}

export const deliveryWorker = new Worker<DeliveryJobData>(DELIVERY_QUEUE_NAME, processDelivery, {
  connection: redisConnection,
  concurrency: config.DELIVERY_CONCURRENCY,
});

deliveryWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "delivery job threw unexpectedly");
});

async function runRecoveryAndReconciliation() {
  await recoverStaleProcessingDeliveries();
  await reconcilePendingDeliveries();
}

const stopMaintenance = startMaintenanceLoop(
  runRecoveryAndReconciliation,
  RECONCILE_INTERVAL_MS,
  (error) => logger.warn({ err: error }, "delivery recovery/reconciliation failed")
);

let shuttingDown = false;
export async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "delivery worker shutting down; waiting for active jobs");

  try {
    // Stop accepting work and drain both active jobs and any maintenance pass
    // before closing the queue and database they still use.
    await Promise.all([stopMaintenance(), deliveryWorker.close()]);
    await deliveryQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    logger.info("delivery worker stopped cleanly");
    process.exitCode = 0;
  } catch (error) {
    logger.error({ err: error }, "delivery worker shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

logger.info("delivery worker started");
