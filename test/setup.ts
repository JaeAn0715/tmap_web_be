import { afterAll, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ClusterNote",
      "ClusterPoiLike",
      "ClusterMembership",
      "PoiPersonalNote",
      "RecentDestination",
      "UserSavedPlaces",
      "Cluster",
      "User"
    RESTART IDENTITY CASCADE;
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
