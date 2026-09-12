import { Worker, Job } from "bullmq";
import { prisma } from "../db";
import { config } from "../config";
import { logger } from "../lib/logger";
import { assertSafeWebhookUrl, readResponseSnippet } from "../lib/network";
import { signPayload } from "../lib/signature";
import { redisConnection } from "./connection";
import { DELIVERY_QUEUE_NAME, DeliveryJobData, computeBackoffMs, enqueueDelivery } from "./deliveryQueue";
import { reconcilePendingDeliveries } from "./reconcile";

const MAX_RESPONSE_SNIPPET_BYTES = 2000;
const RECONCILE_INTERVAL_MS = 30_000;

/**
 * Performs one delivery attempt: loads the delivery + its event/subscription,
 * validates the destination again at send time, POSTs the signed payload,
 * records the outcome, and either succeeds, schedules retry, or exhausts.
 */
async function processDelivery(job: Job<DeliveryJobData>) {
  const { deliveryId, attemptNumber } = job.data;

  const delivery = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    include: { event: true, subscription: true },
  });

  if (!delivery) {
    logger.warn({ deliveryId }, "delivery not found, skipping (likely deleted)");
    return;
  }

  const expectedAttempt = delivery.attemptCount + 1;
  if (attemptNumber !== expectedAttempt) {
    logger.info(
      { deliveryId, attemptNumber, expectedAttempt, status: delivery.status },
      "skipping stale delivery queue projection"
    );
    return;
  }

  if (delivery.status !== "PENDING" && delivery.status !== "RETRYING") {
    logger.info({ deliveryId, status: delivery.status }, "delivery is already terminal, skipping");
    return;
  }

  if (delivery.subscription.status !== "ACTIVE") {
    logger.info({ deliveryId }, "subscription no longer active, skipping delivery");
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "FAILED", errorMessage: "Subscription paused or disabled" },
    });
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
    // Resolve and validate on every attempt so a hostname that later changes to
    // a loopback/private/metadata address cannot bypass creation-time checks.
    const target = await assertSafeWebhookUrl(delivery.subscription.targetUrl);

    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Webhook-Signature": signature,
        "Webhook-Event-Type": delivery.event.type,
        "Webhook-Delivery-Id": delivery.id,
        "User-Agent": "webhook-relay/1.0",
      },
      body: rawBody,
      signal: controller.signal,
      // Redirect targets are not trusted implicitly; following redirects could
      // otherwise turn a public URL into an SSRF hop to an internal service.
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
      attemptNumber,
      durationMs,
      responseStatus,
      responseBodySnippet,
      errorMessage,
    },
  });

  if (succeeded) {
    await prisma.$transaction([
      prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: "SUCCEEDED",
          attemptCount: attemptNumber,
          lastAttemptAt: new Date(),
          nextAttemptAt: null,
          responseStatus,
          responseBodySnippet,
          errorMessage: null,
        },
      }),
      prisma.subscription.update({
        where: { id: delivery.subscriptionId },
        data: { consecutiveFailures: 0 },
      }),
    ]);
    logger.info({ deliveryId, attemptNumber, durationMs }, "delivery succeeded");
    return;
  }

  const exhausted = attemptNumber >= delivery.maxAttempts;

  if (exhausted) {
    const failures = delivery.subscription.consecutiveFailures + 1;
    const shouldDisable = failures >= config.SUBSCRIPTION_AUTO_DISABLE_THRESHOLD;

    await prisma.$transaction([
      prisma.delivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          attemptCount: attemptNumber,
          lastAttemptAt: new Date(),
          nextAttemptAt: null,
          responseStatus,
          responseBodySnippet,
          errorMessage,
        },
      }),
      prisma.subscription.update({
        where: { id: delivery.subscriptionId },
        data: {
          consecutiveFailures: failures,
          ...(shouldDisable ? { status: "DISABLED" as const } : {}),
        },
      }),
    ]);
    logger.warn({ deliveryId, attemptNumber, shouldDisable }, "delivery exhausted all attempts");
    return;
  }

  const delay = computeBackoffMs(attemptNumber);
  const nextAttemptAt = new Date(Date.now() + delay);

  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      status: "RETRYING",
      attemptCount: attemptNumber,
      lastAttemptAt: new Date(),
      nextAttemptAt,
      responseStatus,
      responseBodySnippet,
      errorMessage,
    },
  });

  try {
    await enqueueDelivery(delivery.id, attemptNumber + 1, delay);
  } catch (error) {
    logger.warn(
      { err: error, deliveryId, attemptNumber: attemptNumber + 1 },
      "retry persisted but queue projection failed; reconciliation will repair it"
    );
  }

  logger.info({ deliveryId, attemptNumber, nextAttemptAt }, "delivery scheduled for retry");
}

export const deliveryWorker = new Worker<DeliveryJobData>(DELIVERY_QUEUE_NAME, processDelivery, {
  connection: redisConnection,
  concurrency: config.DELIVERY_CONCURRENCY,
});

deliveryWorker.on("failed", (job, err) => {
  // Unexpected exceptions leave durable PENDING/RETRYING state intact; the
  // reconciler can rebuild the deterministic queue projection after Redis or
  // database availability recovers.
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
