CREATE TABLE "PreviewRegistration" (
    "handle" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreviewRegistration_pkey" PRIMARY KEY ("handle")
);
CREATE INDEX "PreviewRegistration_accountId_idx" ON "PreviewRegistration"("accountId");
ALTER TABLE "PreviewRegistration" ADD CONSTRAINT "PreviewRegistration_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreviewRegistration" ADD CONSTRAINT "PreviewRegistration_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
