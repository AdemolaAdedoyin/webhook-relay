import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger";
import { requireAuth, requireScope, scopeByMethod } from "./middleware/auth";
import { errorHandler } from "./middleware/errorHandler";
import { subscriptionRouter } from "./modules/subscriptions/subscription.routes";
import { eventRouter } from "./modules/events/event.routes";
import { deliveryRouter } from "./modules/deliveries/delivery.routes";

import { checkReadiness } from "./lib/readiness";
import { keyRouter } from "./modules/keys/key.routes";
import { operationsRouter } from "./modules/operations/operations.routes";

export function createApp() {
  const app = express();

  app.use(cors({ exposedHeaders: ["X-Request-Id"] }));
  app.use(pinoHttp({
    logger,
    genReqId(req, res) {
      const supplied = req.headers["x-request-id"];
      const id = typeof supplied === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
        ? supplied : randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    // Credentials, cookies, payloads and query strings never enter access logs.
    serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url?.split("?")[0] }) },
  }));
  app.use(express.json({ limit: "1mb" }));

  // Liveness/readiness stay available independently of tenant traffic limits.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/ready", async (_req, res, next) => {
    try {
      const readiness = await checkReadiness();
      res.setHeader("Cache-Control", "no-store");
      res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
    } catch (error) { next(error); }
  });

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

  app.use("/v1/keys", requireAuth, requireScope("admin"), keyRouter);
  app.use("/v1/operations", requireAuth, requireScope("read"), operationsRouter);
  app.use("/v1/subscriptions", requireAuth, scopeByMethod("manage_subscriptions"), subscriptionRouter);
  app.use("/v1/events", requireAuth, scopeByMethod("publish"), eventRouter);
  app.use("/v1/deliveries", requireAuth, scopeByMethod("replay"), deliveryRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);

  return app;
}
