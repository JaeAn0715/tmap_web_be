import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";

/** Stable id so share link `#/c/babyAiDemo012345678901234567890` matches docs. */
export const DEMO_BABY_AI_CLUSTER_ID = "babyAiDemo012345678901234567890";

const postBodySchema = z.object({
  /** If set, only this Google-linked email may run the seed (extra guard). */
  expectEmail: z.string().email().optional(),
});

const NOTE_TEMPLATES = [
  "유모차가 통과하기엔 통로가 좁았고, 계단 구간이 있어 견인이 불편했습니다. (실험용 데모 코멘트)",
  "아기의자는 2~3테이블 분량 있었고 예약 시 미리 요청하는 편이 안전해 보였습니다.",
  "이유식 데우기·조리 지원 여부는 매장마다 다른 듯해 방문 전 문의가 필요합니다.",
] as const;

function demoSeedAllowed(request: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const secret = process.env.DEMO_SEED_SECRET?.trim();
  const hdr = request.headers["x-demo-seed-secret"];
  const v = Array.isArray(hdr) ? hdr[0] : hdr;
  if (secret) return (v?.trim() ?? "") === secret;
  return process.env.NODE_ENV !== "production";
}

function buildDemoPois(count: number) {
  const baseLat = 37.5665;
  const baseLng = 126.978;
  const pois: Array<{
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    category: string;
  }> = [];
  for (let i = 0; i < count; i++) {
    const id = `demoBabyPoi${String(i).padStart(3, "0")}`;
    pois.push({
      id,
      name: `데모 맛집 ${i + 1}`,
      address: `서울 데모로 ${i + 1} (실험용 데이터)`,
      lat: baseLat + (i % 10) * 0.002,
      lng: baseLng + Math.floor(i / 10) * 0.002,
      category: "음식점",
    });
  }
  return pois;
}

export const demoBabyAiRoutes: FastifyPluginAsync = async (app) => {
  app.post("/demo/baby-ai-summary-seed", async (request, reply) => {
    if (!demoSeedAllowed(request)) {
      return reply.code(403).send({
        error:
          "Demo seed disabled. Set DEMO_SEED_SECRET in server .env and send header X-Demo-Seed-Secret with the same value, or run with NODE_ENV not production and omit DEMO_SEED_SECRET.",
      });
    }

    const user = requireUser(request, reply);
    if (!user) return;

    const parsed = postBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    if (parsed.data.expectEmail) {
      const want = parsed.data.expectEmail.toLowerCase().trim();
      const got = user.email?.toLowerCase().trim() ?? "";
      if (got !== want) {
        return reply.code(403).send({
          error: "Signed-in user email does not match expectEmail.",
        });
      }
    }

    const existing = await prisma.cluster.findUnique({
      where: { id: DEMO_BABY_AI_CLUSTER_ID },
    });
    if (existing && existing.ownerId !== user.id) {
      return reply.code(409).send({
        error: "Demo cluster id is already used by another account.",
      });
    }
    if (existing) {
      await prisma.cluster.delete({ where: { id: DEMO_BABY_AI_CLUSTER_ID } });
    }

    const pois = buildDemoPois(50);
    const mapCenter = { lat: 37.5665, lng: 126.978 };
    const userName = user.name ?? user.email ?? "User";

    const noteRows = pois.flatMap((p) =>
      NOTE_TEMPLATES.map((text) => ({
        clusterId: DEMO_BABY_AI_CLUSTER_ID,
        poiId: p.id,
        userId: user.id,
        userName,
        text,
      })),
    );

    await prisma.$transaction([
      prisma.cluster.create({
        data: {
          id: DEMO_BABY_AI_CLUSTER_ID,
          name: "실험용",
          ownerId: user.id,
          mapCenter: mapCenter as object,
          mapZoom: 14,
          pois: pois as object[],
        },
      }),
      prisma.clusterNote.createMany({ data: noteRows }),
    ]);

    const first = pois[0]!;
    return {
      clusterId: DEMO_BABY_AI_CLUSTER_ID,
      clusterName: "실험용",
      poiCount: pois.length,
      notesCreated: noteRows.length,
      samplePoi: first,
      sampleUserComments: [...NOTE_TEMPLATES],
    };
  });
};
