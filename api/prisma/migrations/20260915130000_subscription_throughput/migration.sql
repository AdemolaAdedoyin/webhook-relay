ALTER TABLE "Subscription"
ADD COLUMN "maxConcurrentDeliveries" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "minDeliveryIntervalMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextDeliveryAllowedAt" TIMESTAMP(3);
ALTER TABLE "Subscription"
ADD CONSTRAINT "Subscription_maxConcurrentDeliveries_check" CHECK ("maxConcurrentDeliveries" BETWEEN 1 AND 100),
ADD CONSTRAINT "Subscription_minDeliveryIntervalMs_check" CHECK ("minDeliveryIntervalMs" BETWEEN 0 AND 3600000);
