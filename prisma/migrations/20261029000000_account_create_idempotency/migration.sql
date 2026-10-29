CREATE TABLE "AccountCreateIdempotency" (
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "resultAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountCreateIdempotency_pkey" PRIMARY KEY ("userId", "operation", "key")
);

CREATE INDEX "AccountCreateIdempotency_userId_idx" ON "AccountCreateIdempotency"("userId");
