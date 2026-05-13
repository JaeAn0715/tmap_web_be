import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { verifyGoogleIdToken } from "../lib/google-verify.js";
import { signUserToken } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

const googleBodySchema = z.object({
  credential: z.string().min(1),
});

export type AuthRoutesOptions = {
  jwtSecret: string;
  googleClientId: string;
};

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, opts) => {
  app.post("/auth/google", async (request, reply) => {
    const parsed = googleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    let payload;
    try {
      payload = await verifyGoogleIdToken(parsed.data.credential, opts.googleClientId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Auth failed";
      return reply.code(401).send({ error: msg });
    }

    const updateData: Prisma.UserUpdateInput = {};
    if (payload.email !== undefined) updateData.email = payload.email ?? null;
    if (payload.name !== undefined) updateData.name = payload.name ?? null;
    if (payload.picture !== undefined) updateData.pictureUrl = payload.picture ?? null;

    const user = await prisma.user.upsert({
      where: { googleSub: payload.sub },
      create: {
        googleSub: payload.sub,
        email: payload.email ?? null,
        name: payload.name ?? null,
        pictureUrl: payload.picture ?? null,
      },
      update:
        Object.keys(updateData).length > 0
          ? updateData
          : {
              googleSub: payload.sub,
            },
    });

    const token = signUserToken(user.id, opts.jwtSecret);
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        pictureUrl: user.pictureUrl,
      },
    };
  });

  app.post("/auth/logout", async () => {
    return { ok: true };
  });
};
