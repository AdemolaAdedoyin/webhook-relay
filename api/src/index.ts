import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./db";
import { reconcilePendingDeliveries } from "./queue/reconcile";

const RECONCILE_INTERVAL_MS = 30_000;
const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(`webhook-relay API listening on :${config.PORT}`);
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

async function shutdown(signal: string) {
  logger.info(`received ${signal}, shutting down gracefully`);
  clearInterval(reconcileTimer);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Force-exit if graceful shutdown hangs
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
