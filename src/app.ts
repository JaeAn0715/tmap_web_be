import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { attachJwtPreHandler } from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { poiPersonalNotesRoutes } from "./routes/poi-personal-notes.js";
import { clusterRoutes } from "./routes/clusters.js";
import { aiRoutes } from "./routes/ai.js";
import { demoBabyAiRoutes } from "./routes/demo-baby-ai.js";

export type BuildAppOptions = {
  jwtSecret: string;
  googleClientId: string;
  corsOrigin: boolean | string | string[];
  geminiApiKey: string;
  geminiModel: string;
};

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.VITEST === "true" ? false : true,
    bodyLimit: 6 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: opts.corsOrigin,
    credentials: true,
  });

  await app.register(async (scoped) => {
    attachJwtPreHandler(scoped, { jwtSecret: opts.jwtSecret });
    await scoped.register(authRoutes, {
      jwtSecret: opts.jwtSecret,
      googleClientId: opts.googleClientId,
    });
    await scoped.register(meRoutes);
    await scoped.register(poiPersonalNotesRoutes);
    await scoped.register(clusterRoutes);
    await scoped.register(aiRoutes, {
      geminiApiKey: opts.geminiApiKey,
      geminiModel: opts.geminiModel,
    });
    await scoped.register(demoBabyAiRoutes);
  });

  app.get("/health", async () => ({ ok: true }));

  return app;
}
