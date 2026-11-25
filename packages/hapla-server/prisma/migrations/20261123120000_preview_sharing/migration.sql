ALTER TABLE "PreviewRegistration" ADD COLUMN "access" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "PreviewRegistration" ADD COLUMN "shareKeyHash" TEXT;
ALTER TABLE "PreviewRegistration" ADD COLUMN "accessVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PreviewRegistration" ADD CONSTRAINT "PreviewRegistration_access_check" CHECK ("access" IN ('private', 'users', 'key'));
CREATE INDEX "PreviewRegistration_access_idx" ON "PreviewRegistration"("access");
