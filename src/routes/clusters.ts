import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";
import {
  buildClusterPayload,
  touchClusterUpdatedAt,
} from "../services/cluster-payload.js";
import { isValidProposedClusterId, newClusterId } from "../services/cluster-id.js";
import { clusterCreateSchema, clusterPatchSchema, forkClusterSchema } from "../schemas/cluster.js";
import {
  buildNoteCreateSchema,
  buildNotePatchSchema,
  imageUrlsFromDb,
} from "../schemas/cluster-notes.js";
import { ingestReviewTextForInterestNouns } from "../services/user-interest-nouns.js";

export const clusterRoutes: FastifyPluginAsync = async (app) => {
  app.get("/clusters/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cluster = await prisma.cluster.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }
    return buildClusterPayload(cluster);
  });

  app.post("/clusters", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const parsed = clusterCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const id = parsed.data.id ?? newClusterId();
    if (parsed.data.id && !isValidProposedClusterId(parsed.data.id)) {
      return reply.code(400).send({ error: "Invalid cluster id proposal" });
    }

    const existingById = await prisma.cluster.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (existingById) {
      if (existingById.ownerId !== user.id) {
        return reply.code(409).send({ error: "Cluster id already exists" });
      }
      return buildClusterPayload(existingById);
    }

    const mapCenter = parsed.data.mapCenter;
    const poiSig = parsed.data.pois
      .map((p) => p.id)
      .sort()
      .join("|");
    const since = new Date(Date.now() - 15_000);
    const recentSame = await prisma.cluster.findMany({
      where: {
        ownerId: user.id,
        name: parsed.data.name,
        mapZoom: parsed.data.mapZoom,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { owner: true },
    });
    for (const c of recentSame) {
      const mc = c.mapCenter as { lat?: number; lng?: number };
      if (mc?.lat !== mapCenter.lat || mc?.lng !== mapCenter.lng) continue;
      const prevSig = (c.pois as { id: string }[])
        .map((p) => p.id)
        .sort()
        .join("|");
      if (prevSig === poiSig) {
        return buildClusterPayload(c);
      }
    }

    let cluster;
    try {
      cluster = await prisma.cluster.create({
        data: {
          id,
          name: parsed.data.name,
          ownerId: user.id,
          mapCenter: parsed.data.mapCenter as object,
          mapZoom: parsed.data.mapZoom,
          pois: parsed.data.pois as object[],
        },
        include: { owner: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const row = await prisma.cluster.findUnique({
          where: { id },
          include: { owner: true },
        });
        if (row?.ownerId === user.id) {
          return buildClusterPayload(row);
        }
      }
      throw e;
    }

    return buildClusterPayload(cluster);
  });

  app.patch("/clusters/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };

    const cluster = await prisma.cluster.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }
    if (cluster.ownerId !== user.id) {
      return reply.code(403).send({ error: "Only owner can update cluster" });
    }

    const parsed = clusterPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const data: {
      name?: string;
      mapCenter?: object;
      mapZoom?: number;
      pois?: object[];
    } = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.mapCenter !== undefined) data.mapCenter = parsed.data.mapCenter as object;
    if (parsed.data.mapZoom !== undefined) data.mapZoom = parsed.data.mapZoom;
    if (parsed.data.pois !== undefined) {
      data.pois = parsed.data.pois as object[];
      const seen = new Set<string>();
      for (const p of parsed.data.pois) {
        if (seen.has(p.id)) {
          return reply.code(400).send({ error: "Duplicate poi id in payload" });
        }
        seen.add(p.id);
      }
    }

    const updated = await prisma.cluster.update({
      where: { id },
      data,
      include: { owner: true },
    });

    if (parsed.data.pois !== undefined) {
      const poiIds = new Set(parsed.data.pois.map((p) => p.id));
      await prisma.clusterPoiLike.deleteMany({
        where: { clusterId: id, poiId: { notIn: [...poiIds] } },
      });
      await prisma.clusterNote.deleteMany({
        where: { clusterId: id, poiId: { notIn: [...poiIds] } },
      });
    }

    return buildClusterPayload(updated);
  });

  app.delete("/clusters/:id", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };

    const cluster = await prisma.cluster.findUnique({ where: { id } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }
    if (cluster.ownerId !== user.id) {
      return reply.code(403).send({ error: "Only owner can delete cluster" });
    }

    await prisma.cluster.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.post("/clusters/:id/fork", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = request.params as { id: string };

    const source = await prisma.cluster.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!source) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    const parsed = forkClusterSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const newId = newClusterId();
    const name = parsed.data.name ?? `${source.name} (사본)`;

    const created = await prisma.cluster.create({
      data: {
        id: newId,
        name,
        ownerId: user.id,
        mapCenter: source.mapCenter as object,
        mapZoom: source.mapZoom,
        pois: source.pois as object[],
      },
      include: { owner: true },
    });

    return buildClusterPayload(created);
  });

  app.post("/clusters/:clusterId/pois/:poiId/likes", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId, poiId } = request.params as { clusterId: string; poiId: string };

    const cluster = await prisma.cluster.findUnique({
      where: { id: clusterId },
      include: { owner: true },
    });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    const pois = cluster.pois as { id: string }[];
    if (!pois.some((p) => p.id === poiId)) {
      return reply.code(400).send({ error: "Unknown poi id" });
    }

    const userName = user.name ?? user.email ?? "User";

    const existing = await prisma.clusterPoiLike.findUnique({
      where: {
        clusterId_poiId_userId: { clusterId, poiId, userId: user.id },
      },
    });

    if (existing) {
      await prisma.clusterPoiLike.delete({ where: { id: existing.id } });
      await touchClusterUpdatedAt(clusterId);
      return buildClusterPayload(
        (await prisma.cluster.findUnique({
          where: { id: clusterId },
          include: { owner: true },
        }))!,
      );
    }

    await prisma.clusterPoiLike.create({
      data: {
        clusterId,
        poiId,
        userId: user.id,
        userName,
      },
    });
    await touchClusterUpdatedAt(clusterId);

    return buildClusterPayload(
      (await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { owner: true },
      }))!,
    );
  });

  app.delete("/clusters/:clusterId/pois/:poiId/likes", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId, poiId } = request.params as { clusterId: string; poiId: string };

    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    await prisma.clusterPoiLike.deleteMany({
      where: { clusterId, poiId, userId: user.id },
    });
    await touchClusterUpdatedAt(clusterId);

    return buildClusterPayload(
      (await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { owner: true },
      }))!,
    );
  });

  app.post("/clusters/:clusterId/pois/:poiId/notes", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId, poiId } = request.params as { clusterId: string; poiId: string };

    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }
    const pois = cluster.pois as { id: string }[];
    if (!pois.some((p) => p.id === poiId)) {
      return reply.code(400).send({ error: "Unknown poi id" });
    }

    const parsed = buildNoteCreateSchema().safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const userName = user.name ?? user.email ?? "User";
    const urls = parsed.data.imageUrls ?? [];
    await prisma.clusterNote.create({
      data: {
        clusterId,
        poiId,
        userId: user.id,
        userName,
        text: parsed.data.text,
        ...(urls.length > 0 ? { imageUrls: urls as Prisma.InputJsonValue } : {}),
      },
    });
    await ingestReviewTextForInterestNouns(user.id, parsed.data.text);
    await touchClusterUpdatedAt(clusterId);

    return buildClusterPayload(
      (await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { owner: true },
      }))!,
    );
  });

  app.patch("/clusters/:clusterId/pois/:poiId/notes/:noteId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId, poiId, noteId } = request.params as {
      clusterId: string;
      poiId: string;
      noteId: string;
    };

    const note = await prisma.clusterNote.findFirst({
      where: { id: noteId, clusterId, poiId },
    });
    if (!note) {
      return reply.code(404).send({ error: "Note not found" });
    }
    if (note.userId !== user.id) {
      return reply.code(403).send({ error: "Only author can edit note" });
    }

    const parsed = buildNotePatchSchema().safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const existingUrls = imageUrlsFromDb(note.imageUrls);
    const mergedText = parsed.data.text !== undefined ? parsed.data.text : note.text;
    const mergedUrls =
      parsed.data.imageUrls !== undefined ? parsed.data.imageUrls : existingUrls;

    if (mergedText.trim().length === 0 && mergedUrls.length === 0) {
      return reply.code(400).send({
        error: "After merge, note would have no text and no images. Send imageUrls again when only changing text.",
      });
    }

    await prisma.clusterNote.update({
      where: { id: noteId },
      data: {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(parsed.data.imageUrls !== undefined
          ? {
              imageUrls:
                mergedUrls.length > 0
                  ? (mergedUrls as Prisma.InputJsonValue)
                  : Prisma.JsonNull,
            }
          : {}),
        editedAt: new Date(),
      },
    });
    await touchClusterUpdatedAt(clusterId);

    return buildClusterPayload(
      (await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { owner: true },
      }))!,
    );
  });

  app.delete("/clusters/:clusterId/pois/:poiId/notes/:noteId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { clusterId, poiId, noteId } = request.params as {
      clusterId: string;
      poiId: string;
      noteId: string;
    };

    const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } });
    if (!cluster) {
      return reply.code(404).send({ error: "Cluster not found" });
    }

    const note = await prisma.clusterNote.findFirst({
      where: { id: noteId, clusterId, poiId },
    });
    if (!note) {
      return reply.code(404).send({ error: "Note not found" });
    }

    const isAuthor = note.userId === user.id;
    const isOwner = cluster.ownerId === user.id;
    if (!isAuthor && !isOwner) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    await prisma.clusterNote.delete({ where: { id: noteId } });
    await touchClusterUpdatedAt(clusterId);

    return buildClusterPayload(
      (await prisma.cluster.findUnique({
        where: { id: clusterId },
        include: { owner: true },
      }))!,
    );
  });
};
