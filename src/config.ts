export function loadConfig() {
  const usePglite = process.env.USE_PGLITE === "1";
  const databaseUrl = process.env.DATABASE_URL;
  if (!usePglite && !databaseUrl) {
    throw new Error("DATABASE_URL is required (or set USE_PGLITE=1 for embedded Postgres)");
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required");
  }
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";
  const corsOrigin = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? true;
  const geminiApiKey = process.env.GEMINI_API_KEY ?? "";
  const geminiModel =
    process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash-lite";

  return {
    databaseUrl: databaseUrl ?? "postgresql://unused:unused@127.0.0.1:5432/_pglite_placeholder",
    jwtSecret,
    googleClientId,
    port,
    host,
    corsOrigin,
    usePglite,
    geminiApiKey,
    geminiModel,
  };
}
