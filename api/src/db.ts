import { PrismaClient } from "@prisma/client";

// A single PrismaClient instance is reused across the process. In dev with
// hot-reload (tsx watch) we stash it on `global` to avoid exhausting the
// Postgres connection pool across reloads.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
