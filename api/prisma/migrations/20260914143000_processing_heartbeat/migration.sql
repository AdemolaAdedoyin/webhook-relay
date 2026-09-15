ALTER TABLE "Delivery"
ADD COLUMN "processingHeartbeatAt" TIMESTAMP(3);

CREATE INDEX "Delivery_status_processingHeartbeatAt_idx"
ON "Delivery"("status", "processingHeartbeatAt");
