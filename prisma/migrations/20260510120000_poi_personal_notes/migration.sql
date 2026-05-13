-- CreateTable
CREATE TABLE "PoiPersonalNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "poiId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "imageUrls" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "PoiPersonalNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PoiPersonalNote_userId_poiId_idx" ON "PoiPersonalNote"("userId", "poiId");

-- CreateIndex
CREATE INDEX "PoiPersonalNote_userId_createdAt_idx" ON "PoiPersonalNote"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PoiPersonalNote" ADD CONSTRAINT "PoiPersonalNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
