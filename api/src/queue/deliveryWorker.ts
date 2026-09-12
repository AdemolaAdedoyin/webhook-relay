import { Worker, Job } from "bullmq";
import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { assertSafeWebhookUrl, readResponseSnippet } from "../lib/network";
import { signPayload } from "../lib/signature";
import { redisConnection } from "./connection";
import { DELIVERY_QUEUE_NAME, DeliveryJobData, computeBackoffMs, enqueueDelivery } from "./deliveryQueue";
import { claimDeliveryAttempt } from "./deliveryLifecycle";
import { reconcilePendingDeliveries } from "./reconcile";

const MAX_RESPONSE_SNIPPET_BYTES = 2000;
const RECONCILE_INTERVAL_MS = 30_000;

/**
 * Performs one delivery attempt. The durable row is atomically claimed before
 * any network side effect so duplicate BullMQ projections/workers cannot send
 * the same run/attempt concurrently.
 */
async function processDelivery(job: Job<DeliveryJobData>) {
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

  const claimed = await claimDeliveryAttempt(deliveryId, runNumber, attemptNumber);
  if (!claimed) {
    logger.info({ deliveryId, runNumber, attemptNumber }, "delivery attempt was claimed elsewhere");
    return;
  }

  if (delivery.subscription.status !== "ACTIVE") {
    await prisma.delivery.updateMany({
      where: {
        id: deliveryId,
        runNumber,
        attemptCount: attemptNumber,
        status: "PROCESSING",
      },
      data: {
        status: "FAILED",
        nextAttemptAt: null,
        errorMessage: "Subscription paused or disabled",
      },
    });
    logger.info({ deliveryId, runNumber, attemptNumber }, "subscription is not active; delivery failed");
    return;
  }

  const rawBody = JSON.stringify({
    id: delivery.event.id,
    type: delivery.event.type,
    createdAt: delivery.event.createdAt,
    data: delivery.event.payload,
  });
  const signature = signPayload(rawBody, delivery.subscription.secret);

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
}

export const deliveryWorker = new Worker<DeliveryJobData>(DELIVERY_QUEUE_NAME, processDelivery, {
  connection: redisConnection,
  concurrency: config.DELIVERY_CONCURRENCY,
});

deliveryWorker.on("failed", (job, err) => {
  // Once a worker has atomically claimed an attempt, an unexpected process/DB
  // failure may leave it PROCESSING. Phase 6 adds stale in-flight recovery.
  logger.error({ jobId: job?.id, err }, "delivery job threw unexpectedly");
});

void reconcilePendingDeliveries().catch((error) => {
  logger.warn({ err: error }, "initial delivery reconciliation failed");
});

const reconcileTimer = setInterval(() => {
  void reconcilePendingDeliveries().catch((error) => {
    logger.warn({ err: error }, "periodic delivery reconciliation failed");
  });
}, RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

logger.info("delivery worker started");
