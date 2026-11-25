CREATE TABLE "PreviewBrowserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreviewBrowserSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PreviewBrowserSession_accountId_idx" ON "PreviewBrowserSession"("accountId");
CREATE INDEX "PreviewBrowserSession_expiresAt_idx" ON "PreviewBrowserSession"("expiresAt");
