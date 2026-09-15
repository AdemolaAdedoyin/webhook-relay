import { Router } from "express";
import { formatOperationsMetrics, getOperationsOverview } from "./operations.service";

export const operationsRouter = Router();
operationsRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
operationsRouter.get("/", async (req, res, next) => {
  try { res.json(await getOperationsOverview((req as any).tenantId)); }
  catch (error) { next(error); }
});
operationsRouter.get("/metrics", async (req, res, next) => {
  try {
    const overview = await getOperationsOverview((req as any).tenantId);
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(formatOperationsMetrics(overview));
  } catch (error) { next(error); }
});
