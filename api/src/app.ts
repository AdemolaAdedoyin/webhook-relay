import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { requireAuth } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { subscriptionRouter } from "./modules/subscriptions/subscription.routes";
import { eventRouter } from "./modules/events/event.routes";
import { deliveryRouter } from "./modules/deliveries/delivery.routes";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(pinoHttp({ logger }));

  // Generous but present: protects the ingest endpoint from a misbehaving
  // publisher without needing a separate API gateway for this portfolio scope.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/v1/subscriptions", requireAuth, subscriptionRouter);
  app.use("/v1/events", requireAuth, eventRouter);
  app.use("/v1/deliveries", requireAuth, deliveryRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);

  return app;
}
