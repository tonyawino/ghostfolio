-- No foreign key to Order: a deleted result remains a permanent tombstone.
CREATE TABLE "ActivityCreateIdempotency" (
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "resultOrderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityCreateIdempotency_pkey" PRIMARY KEY ("userId", "operation", "key")
);

CREATE INDEX "ActivityCreateIdempotency_userId_idx" ON "ActivityCreateIdempotency"("userId");
