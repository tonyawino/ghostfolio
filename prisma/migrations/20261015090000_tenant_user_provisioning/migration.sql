-- CreateTable
CREATE TABLE "TenantUserProvisioning" (
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encryptedAccessToken" BYTEA NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "provisioningKey" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TenantUserProvisioning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantUserProvisioning_provisioningKey_key" ON "TenantUserProvisioning"("provisioningKey");

-- CreateIndex
CREATE UNIQUE INDEX "TenantUserProvisioning_tenantId_key" ON "TenantUserProvisioning"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantUserProvisioning_userId_key" ON "TenantUserProvisioning"("userId");

-- CreateIndex
CREATE INDEX "TenantUserProvisioning_createdAt_idx" ON "TenantUserProvisioning"("createdAt");

-- AddForeignKey
ALTER TABLE "TenantUserProvisioning" ADD CONSTRAINT "TenantUserProvisioning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
