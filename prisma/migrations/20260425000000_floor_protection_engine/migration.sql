-- Floor Protection Engine migration
-- Adds: FloorProtectionLog table, heartbeatAt to SchedulerLock

-- AlterTable: add heartbeatAt to SchedulerLock
ALTER TABLE "SchedulerLock" ADD COLUMN "heartbeatAt" DATETIME;

-- CreateTable: FloorProtectionLog
CREATE TABLE "FloorProtectionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nmId" INTEGER NOT NULL,
    "productId" TEXT,
    "action" TEXT NOT NULL,
    "floorPriceRub" REAL NOT NULL,
    "minBuyerPriceRub" REAL,
    "worstCaseDest" TEXT,
    "worstCaseLabel" TEXT,
    "kObserved" REAL,
    "kSafe" REAL,
    "oldBasePrice" INTEGER,
    "newBasePrice" INTEGER,
    "sellerDiscount" INTEGER,
    "reason" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "allRegionsJson" TEXT
);

-- CreateIndex
CREATE INDEX "FloorProtectionLog_nmId_idx" ON "FloorProtectionLog"("nmId");

-- CreateIndex
CREATE INDEX "FloorProtectionLog_createdAt_idx" ON "FloorProtectionLog"("createdAt");

-- CreateIndex
CREATE INDEX "FloorProtectionLog_action_idx" ON "FloorProtectionLog"("action");
