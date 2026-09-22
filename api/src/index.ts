import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./db";
import { reconcilePendingDeliveries } from "./queue/reconcile";
import { startMaintenanceLoop } from "./queue/maintenanceLoop";
import { deliveryQueue } from "./queue/deliveryQueue";
import { redisConnection } from "./queue/connection";

const server = createApp().listen(config.PORT, () => logger.info(`webhook-relay API listening on :${config.PORT}`));
const stopMaintenance = startMaintenanceLoop(async () => { await reconcilePendingDeliveries(); }, 30_000,
  error => logger.warn({ err: error }, "delivery reconciliation failed"));
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "API shutting down");
  const deadline = setTimeout(() => process.exit(1), 25_000); deadline.unref();
  try {
    await Promise.all([stopMaintenance(), new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))]);
    await deliveryQueue.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    clearTimeout(deadline);
    logger.info("API stopped cleanly");
  } catch (err) { logger.error({ err }, "API shutdown failed"); process.exitCode = 1; }
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
