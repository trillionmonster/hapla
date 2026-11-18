ALTER TABLE "Session"
    ADD COLUMN "lastUserMessageAt" TIMESTAMP(3),
    ADD COLUMN "lastUserMessageIndexedSeq" INTEGER NOT NULL DEFAULT 0;
