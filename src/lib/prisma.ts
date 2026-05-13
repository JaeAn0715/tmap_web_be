import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  __TEST_PRISMA__?: PrismaClient;
};

const testClient = globalForPrisma.__TEST_PRISMA__;

export const prisma: PrismaClient =
  testClient ??
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production" && !testClient) {
  globalForPrisma.prisma = prisma;
}
