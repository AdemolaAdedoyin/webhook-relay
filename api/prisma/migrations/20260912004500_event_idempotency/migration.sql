-- AlterTable
ALTER TABLE "Event"
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "idempotencyFingerprint" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Event_tenantId_idempotencyKey_key"
ON "Event"("tenantId", "idempotencyKey");
