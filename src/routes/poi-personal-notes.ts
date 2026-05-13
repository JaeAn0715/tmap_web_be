import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";
import {
  buildNoteCreateSchema,
  buildNotePatchSchema,
  imageUrlsFromDb,
} from "../schemas/cluster-notes.js";
import { personalPoiNoteToOut } from "../services/cluster-payload.js";

const listQuerySchema = z.object({
  poiId: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
});

const createBodySchema = z
  .object({
    poiId: z.string().min(1).max(512),
  })
  .and(buildNoteCreateSchema());

export const poiPersonalNotesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me/poi-notes", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const q = listQuerySchema.safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({ error: "Invalid query", details: q.error.flatten() });
    }

    const { poiId, limit, offset } = q.data;
    const rows = await prisma.poiPersonalNote.findMany({
      where: {
        userId: user.id,
        ...(poiId ? { poiId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    return { notes: rows.map(personalPoiNoteToOut) };
  });

  app.post("/me/poi-notes", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;

    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }

    const userName = user.name ?? user.email ?? "User";
    const urls = parsed.data.imageUrls ?? [];
    const row = await prisma.poiPersonalNote.create({
      data: {
        userId: user.id,
        poiId: parsed.data.poiId,
        userName,
        text: parsed.data.text,
        ...(urls.length > 0 ? { imageUrls: urls as Prisma.InputJsonValue } : {}),
      },
    });

    return personalPoiNoteToOut(row);
  });

  app.patch("/me/poi-notes/:noteId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { noteId } = request.params as { noteId: string };

    const note = await prisma.poiPersonalNote.findFirst({
      where: { id: noteId, userId: user.id },
    });
    if (!note) {
      return reply.code(404).send({ error: "Note not found" });
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
        error:
          "After merge, note would have no text and no images. Include imageUrls when only changing text.",
      });
    }

    const updated = await prisma.poiPersonalNote.update({
      where: { id: noteId },
      data: {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(parsed.data.imageUrls !== undefined
          ? {
              imageUrls:
                mergedUrls.length > 0 ? (mergedUrls as Prisma.InputJsonValue) : Prisma.JsonNull,
            }
          : {}),
        editedAt: new Date(),
      },
    });

    return personalPoiNoteToOut(updated);
  });

  app.delete("/me/poi-notes/:noteId", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { noteId } = request.params as { noteId: string };

    const note = await prisma.poiPersonalNote.findFirst({
      where: { id: noteId, userId: user.id },
    });
    if (!note) {
      return reply.code(404).send({ error: "Note not found" });
    }

    await prisma.poiPersonalNote.delete({ where: { id: noteId } });
    return reply.code(204).send();
  });
};
