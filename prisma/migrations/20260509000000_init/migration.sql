-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "googleSub" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "pictureUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSavedPlaces" (
    "userId" TEXT NOT NULL,
    "homeJson" JSONB,
    "workJson" JSONB,

    CONSTRAINT "UserSavedPlaces_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "mapCenter" JSONB NOT NULL,
    "mapZoom" DOUBLE PRECISION NOT NULL,
    "pois" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ClusterMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterPoiLike" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "poiId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterPoiLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterNote" (
    "id" TEXT NOT NULL,
    "clusterId" TEXT NOT NULL,
    "poiId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "ClusterNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FavoritePoi" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "poiId" TEXT NOT NULL,
    "poiJson" JSONB NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoritePoi_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecentDestination" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "poiId" TEXT NOT NULL,
    "poiJson" JSONB NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterMembership_userId_clusterId_key" ON "ClusterMembership"("userId", "clusterId");

-- CreateIndex
CREATE INDEX "ClusterMembership_userId_hidden_idx" ON "ClusterMembership"("userId", "hidden");

-- CreateIndex
CREATE UNIQUE INDEX "ClusterPoiLike_clusterId_poiId_userId_key" ON "ClusterPoiLike"("clusterId", "poiId", "userId");

-- CreateIndex
CREATE INDEX "ClusterPoiLike_clusterId_poiId_idx" ON "ClusterPoiLike"("clusterId", "poiId");

-- CreateIndex
CREATE INDEX "ClusterNote_clusterId_poiId_idx" ON "ClusterNote"("clusterId", "poiId");

-- CreateIndex
CREATE UNIQUE INDEX "FavoritePoi_userId_poiId_key" ON "FavoritePoi"("userId", "poiId");

-- CreateIndex
CREATE INDEX "FavoritePoi_userId_ts_idx" ON "FavoritePoi"("userId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "RecentDestination_userId_poiId_key" ON "RecentDestination"("userId", "poiId");

-- CreateIndex
CREATE INDEX "RecentDestination_userId_ts_idx" ON "RecentDestination"("userId", "ts");

-- AddForeignKey
ALTER TABLE "UserSavedPlaces" ADD CONSTRAINT "UserSavedPlaces_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterMembership" ADD CONSTRAINT "ClusterMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterMembership" ADD CONSTRAINT "ClusterMembership_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterPoiLike" ADD CONSTRAINT "ClusterPoiLike_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterPoiLike" ADD CONSTRAINT "ClusterPoiLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterNote" ADD CONSTRAINT "ClusterNote_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterNote" ADD CONSTRAINT "ClusterNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FavoritePoi" ADD CONSTRAINT "FavoritePoi_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentDestination" ADD CONSTRAINT "RecentDestination_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
