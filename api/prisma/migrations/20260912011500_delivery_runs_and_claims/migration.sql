-- AlterEnum
ALTER TYPE "DeliveryStatus" ADD VALUE 'PROCESSING';

-- AlterTable
ALTER TABLE "Delivery"
ADD COLUMN "runNumber" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "DeliveryAttempt"
ADD COLUMN "runNumber" INTEGER NOT NULL DEFAULT 1;

-- Replace the delivery-only history index with deterministic per-run attempt identity.
DROP INDEX IF EXISTS "DeliveryAttempt_deliveryId_idx";
CREATE UNIQUE INDEX "DeliveryAttempt_deliveryId_runNumber_attemptNumber_key"
ON "DeliveryAttempt"("deliveryId", "runNumber", "attemptNumber");
CREATE INDEX "DeliveryAttempt_deliveryId_requestedAt_idx"
ON "DeliveryAttempt"("deliveryId", "requestedAt");
