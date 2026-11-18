CREATE TABLE "SessionProtocolEpoch" (
    "sessionId" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "epochStartedAt" DOUBLE PRECISION NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SessionProtocolEpoch_pkey" PRIMARY KEY ("sessionId", "epoch"),
    CONSTRAINT "SessionProtocolEpoch_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SessionProtocolEpoch_sessionId_epochStartedAt_epoch_idx" ON "SessionProtocolEpoch"("sessionId", "epochStartedAt", "epoch");
CREATE TABLE "SessionProtocolChunk" (
    "sessionId" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "part" INTEGER NOT NULL,
    "parts" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    CONSTRAINT "SessionProtocolChunk_pkey" PRIMARY KEY ("sessionId", "epoch", "seq", "part"),
    CONSTRAINT "SessionProtocolChunk_sessionId_epoch_fkey" FOREIGN KEY ("sessionId", "epoch") REFERENCES "SessionProtocolEpoch"("sessionId", "epoch") ON DELETE CASCADE ON UPDATE CASCADE
);
