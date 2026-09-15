import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../db";
import { SCOPES } from "../../middleware/auth";
import { NotFoundError, ValidationError } from "../../lib/errors";

export const keyRouter = Router();
keyRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
const publicFields = { id: true, name: true, scopes: true, createdAt: true, expiresAt: true, revokedAt: true } as const;
const schema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  expiresAt: z.string().datetime().transform((value) => new Date(value)).refine((value) => value > new Date(), "Expiry must be in the future").optional(),
}).strict();
keyRouter.post("/", async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    const token = `wrk_${randomBytes(32).toString("hex")}`;
    const key = await prisma.apiKey.create({ data: {
      tenantId: (req as any).tenantId, name: parsed.data.name, scopes: [...new Set(parsed.data.scopes)],
      keyHash: createHash("sha256").update(token).digest("hex"), expiresAt: parsed.data.expiresAt ?? null,
    }, select: publicFields });
    res.status(201).json({ ...key, token });
  } catch (error) { next(error); }
});
keyRouter.get("/", async (req, res, next) => {
  try { res.json(await prisma.apiKey.findMany({ where: { tenantId: (req as any).tenantId }, select: publicFields, orderBy: { createdAt: "desc" }, take: 200 })); }
  catch (error) { next(error); }
});
keyRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await prisma.apiKey.updateMany({ where: { id: req.params.id, tenantId: (req as any).tenantId }, data: { revokedAt: new Date() } });
    if (!result.count) throw new NotFoundError("API key", req.params.id);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
