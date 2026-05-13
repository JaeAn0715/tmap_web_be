import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyUserToken } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";
import type { User } from "@prisma/client";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}

export type AuthPluginOptions = { jwtSecret: string };

/** Attach JWT parsing to this Fastify instance (use inside a scoped `register` so it applies to child routes). */
export function attachJwtPreHandler(app: FastifyInstance, opts: AuthPluginOptions): void {
  app.decorateRequest("user", undefined);

  app.addHook("preHandler", async (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    if (!token) {
      return;
    }
    try {
      const { sub } = verifyUserToken(token, opts.jwtSecret);
      const user = await prisma.user.findUnique({ where: { id: sub } });
      if (user) {
        request.user = user;
      }
    } catch {
      // leave user undefined; routes that need auth will 401
    }
  });
}

export function requireUser(request: FastifyRequest, reply: FastifyReply): User | undefined {
  if (!request.user) {
    reply.code(401).send({ error: "Unauthorized" });
    return undefined;
  }
  return request.user;
}
