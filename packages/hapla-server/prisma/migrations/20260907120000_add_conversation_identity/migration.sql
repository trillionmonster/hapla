CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Session" ADD COLUMN "conversationId" TEXT;

CREATE INDEX "Conversation_accountId_updatedAt_idx"
    ON "Conversation"("accountId", "updatedAt" DESC);

CREATE INDEX "Session_accountId_conversationId_idx"
    ON "Session"("accountId", "conversationId");

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Session"
    ADD CONSTRAINT "Session_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
