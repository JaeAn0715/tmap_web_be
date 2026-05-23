import "./load-env.js";

async function main() {
  if (process.env.USE_PGLITE === "1") {
    const { attachPglitePrismaToGlobal } = await import("./lib/pglite-bootstrap.js");
    await attachPglitePrismaToGlobal();
  }

  const { loadConfig } = await import("./config.js");
  const { buildApp } = await import("./app.js");

  const cfg = loadConfig();
  if (!cfg.usePglite) {
    const { prisma } = await import("./lib/prisma.js");
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        [
          "[startup] PostgreSQL에 연결할 수 없습니다.",
          msg,
          "",
          "로컬에서 `npm run dev`를 쓰는 경우:",
          "  1) Docker Desktop 실행 후 `npm run docker:up`",
          "  2) `npx prisma migrate deploy`",
          "Docker 없이 빠르게: `npm run dev:pglite`",
        ].join("\n"),
      );
      process.exit(1);
    }
  }

  const app = await buildApp({
    jwtSecret: cfg.jwtSecret,
    googleClientId: cfg.googleClientId,
    corsOrigin: cfg.corsOrigin,
    geminiApiKey: cfg.geminiApiKey,
    geminiModel: cfg.geminiModel,
  });

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    app.log.info(`Listening on http://${cfg.host}:${cfg.port}`);
    app.log.info(
      cfg.usePglite
        ? "Database: PGlite (in-memory; data resets when the process exits — use `npm run dev:pglite` only for quick tests)"
        : "Database: PostgreSQL (DATABASE_URL — persistent across restarts when using Docker volume)",
    );
    app.log.info(
      cfg.googleClientId
        ? "Google OAuth: GOOGLE_CLIENT_ID loaded"
        : "Google OAuth: GOOGLE_CLIENT_ID missing — /auth/google will return 401 until set in project .env",
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
