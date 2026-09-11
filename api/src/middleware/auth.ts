import { createHash } from "crypto";
import { RequestHandler } from "express";
import { prisma } from "../db";
import { UnauthorizedError } from "../lib/errors";

export interface AuthedRequest extends Express.Request {
  tenantId?: string;
}

// Tenants authenticate with `Authorization: Bearer <apiKey>`. We only ever
// store a SHA-256 hash of the key, never the plaintext, so a DB leak doesn't
// hand out working credentials.
export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedError();
    }

    const apiKeyHash = createHash("sha256").update(token).digest("hex");
    const tenant = await prisma.tenant.findUnique({ where: { apiKeyHash } });
    if (!tenant) {
      throw new UnauthorizedError();
    }

    (req as any).tenantId = tenant.id;
    next();
  } catch (err) {
    next(err);
  }
};
