CREATE TABLE "ApiKey" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_tenantId_createdAt_idx" ON "ApiKey"("tenantId", "createdAt");
INSERT INTO "ApiKey" ("id", "tenantId", "name", "keyHash", "scopes")
SELECT 'legacy-' || "id", "id", 'Migrated tenant key', "apiKeyHash", ARRAY['admin'] FROM "Tenant";
ALTER TABLE "Subscription" ADD COLUMN "previousSecret" TEXT, ADD COLUMN "previousSecretExpiresAt" TIMESTAMP(3);
