import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";
import { buildClusterPayload } from "../services/cluster-payload.js";
import { poiSchema } from "../schemas/poi.js";

const patchMeSchema = z.object({
  name: z.string().optional(),
  pictureUrl: z.string().nullable().optional(),
});

const savedPlacesPutSchema = z.object({
  home: poiSchema.nullable(),
  work: poiSchema.nullable(),
});

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      pictureUrl: user.pictureUrl,
    };
  });

  app.patch("/me", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const parsed = patchMeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.pictureUrl !== undefined
          ? { pictureUrl: parsed.data.pictureUrl }
          : {}),
      },
    });
    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      pictureUrl: updated.pictureUrl,
    };
  });

  app.get("/me/clusters", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const owned = await prisma.cluster.findMany({
      where: { ownerId: user.id },
      include: { owner: true },
      orderBy: { updatedAt: "desc" },
    });

    const memberships = await prisma.clusterMembership.findMany({
      where: { userId: user.id, hidden: false },
      include: { cluster: { include: { owner: true } } },
    });

    const subscribedClusters = memberships
      .map((m) => m.cluster)
      .filter((c) => c.ownerId !== user.id);

    const byId = new Map<string, (typeof owned)[0]>();
    for (const c of owned) {
      byId.set(c.id, c);
    }
    for (const c of subscribedClusters) {
      if (!byId.has(c.id)) {
        byId.set(c.id, c);
      }
    }

    const merged = [...byId.values()].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    );

    const payloads = await Promise.all(merged.map((c) => buildClusterPayload(c)));
    const seen = new Set<string>();
    const clusters = payloads.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    return { clusters };
  });

  app.post("/me/clusters/:clusterId/subscribe", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId } = request.params as { clusterId: string };

    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    if (cluster.ownerId === user.id) {
      return { ok: true };
    }

    await prisma.clusterMembership.upsert({
      where: {
        userId_clusterId: { userId: user.id, clusterId },
      },
      create: { userId: user.id, clusterId, hidden: false },
      update: { hidden: false },
    });

    return { ok: true };
  });

  app.delete("/me/clusters/:clusterId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId } = request.params as { clusterId: string };

    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    if (cluster.ownerId === user.id) {
      return reply
        .code(403)
        .send({ error: "Owner cannot remove owned cluster from list this way" });
    }

    await prisma.clusterMembership.upsert({
      where: {
        userId_clusterId: { userId: user.id, clusterId },
      },
      create: { userId: user.id, clusterId, hidden: true },
      update: { hidden: true },
    });

    return { ok: true };
  });

  app.post("/me/clusters/:clusterId/unfollow", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId } = request.params as { clusterId: string };

    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    if (cluster.ownerId === user.id) {
      return reply
        .code(403)
        .send({ error: "Owner cannot remove owned cluster from list this way" });
    }

    await prisma.clusterMembership.upsert({
      where: {
        userId_clusterId: { userId: user.id, clusterId },
      },
      create: { userId: user.id, clusterId, hidden: true },
      update: { hidden: true },
    });

    return { ok: true };
  });

  app.get("/me/saved-places", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const row = await prisma.userSavedPlaces.findUnique({ where: { userId: user.id } });
    return {
      home: row?.homeJson ?? null,
      work: row?.workJson ?? null,
    };
  });

  app.put("/me/saved-places", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const parsed = savedPlacesPutSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const homeJson =
      parsed.data.home === null ? Prisma.DbNull : (parsed.data.home as object);
    const workJson =
      parsed.data.work === null ? Prisma.DbNull : (parsed.data.work as object);

    await prisma.userSavedPlaces.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        homeJson,
        workJson,
      },
      update: {
        homeJson,
        workJson,
      },
    });

    return parsed.data;
  });

  app.get("/me/recent-destinations", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const limit = Math.min(
      20,
      Math.max(1, Number((request.query as { limit?: string }).limit ?? 10)),
    );

    const rows = await prisma.recentDestination.findMany({
      where: { userId: user.id },
      orderBy: { ts: "desc" },
      take: limit,
    });
    return {
      items: rows.map((r) => ({
        poi: r.poiJson,
        poiId: r.poiId,
        ts: r.ts.getTime(),
      })),
    };
  });

  app.post("/me/recent-destinations", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const parsed = poiSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid POI", details: parsed.error.flatten() });
    }
    const poi = parsed.data;

    await prisma.recentDestination.upsert({
      where: {
        userId_poiId: { userId: user.id, poiId: poi.id },
      },
      create: {
        userId: user.id,
        poiId: poi.id,
        poiJson: poi as object,
        ts: new Date(),
      },
      update: {
        poiJson: poi as object,
        ts: new Date(),
      },
    });

    const all = await prisma.recentDestination.findMany({
      where: { userId: user.id },
      orderBy: { ts: "desc" },
    });
    if (all.length > 20) {
      const toRemove = all.slice(20);
      await prisma.recentDestination.deleteMany({
        where: { id: { in: toRemove.map((r) => r.id) } },
      });
    }

    return { ok: true };
  });

  app.delete("/me/recent-destinations/:poiId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { poiId } = request.params as { poiId: string };
    await prisma.recentDestination.deleteMany({
      where: { userId: user.id, poiId },
    });
    return { ok: true };
  });
};
