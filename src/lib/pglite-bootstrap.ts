import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "@prisma/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** In-process Postgres + Prisma (no Docker). Sets `globalThis.__TEST_PRISMA__` for `lib/prisma.ts`. */
export async function attachPglitePrismaToGlobal(): Promise<void> {
  const pglite = new PGlite();
  const migrationsDir = join(__dirname, "../../prisma/migrations");
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of dirs) {
    const sqlPath = join(migrationsDir, name, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    await pglite.exec(readFileSync(sqlPath, "utf8"));
  }

  const adapterFactory = new PrismaPGlite(pglite);
  // Adapter factory types can mismatch across nested @prisma/driver-adapter-utils copies.
  const client = new PrismaClient({ adapter: adapterFactory as never });
  (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ = client;
}
