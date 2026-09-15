import { createHash } from "crypto";
import { RequestHandler } from "express";
import { prisma } from "../db";
import { AppError, UnauthorizedError } from "../lib/errors";

export const SCOPES = ["admin", "read", "publish", "manage_subscriptions", "replay"] as const;
export type Scope = typeof SCOPES[number];

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(req.headers.authorization ?? "");
    if (!match) throw new UnauthorizedError();
    const keyHash = createHash("sha256").update(match[1]!).digest("hex");
    const key = await prisma.apiKey.findUnique({ where: { keyHash } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) throw new UnauthorizedError();
    (req as any).tenantId = key.tenantId;
    (req as any).scopes = key.scopes;
    next();
  } catch (err) { next(err); }
};

export function requireScope(scope: Scope): RequestHandler {
  return (req, _res, next) => {
    const scopes: string[] = (req as any).scopes ?? [];
    if (scopes.includes("admin") || scopes.includes(scope)) return next();
    next(new AppError("API key lacks the required scope", 403, "FORBIDDEN"));
  };
}
export function scopeByMethod(write: Scope): RequestHandler {
  return (req, res, next) => requireScope(req.method === "GET" || req.method === "HEAD" ? "read" : write)(req, res, next);
}
