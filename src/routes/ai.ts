import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireUser } from "../plugins/auth.js";
import { poiSchema } from "../schemas/poi.js";
import { geminiPoiReviewSummaryServer } from "../lib/gemini-server.js";
import { loadGlobalUserReviewCorpus } from "../services/user-interest-corpus.js";

const bodyPoi = z.object({ poi: poiSchema });
const noteSnippet = z.string().max(4000);
const bodyPoiReviewSummary = z.object({
  poi: poiSchema,
  /** 이 사용자가 남긴 노트·메모 등 (다른 사용자 글 제외) */
  userComments: z.array(noteSnippet).max(200).optional().default([]),
  /** 최근 검색어, 관심 키워드 등 — 예: "유모차" 시 영유아 동반 관점 우선 */
  interestHints: z.array(z.string().max(200)).max(50).optional().default([]),
});

export type AiRoutesOptions = {
  geminiApiKey: string;
  geminiModel: string;
};

export const aiRoutes: FastifyPluginAsync<AiRoutesOptions> = async (app, opts) => {
  const guard = (reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!opts.geminiApiKey) {
      reply.code(503).send({ error: "GEMINI_API_KEY is not configured" });
      return false;
    }
    return true;
  };

  app.post("/ai/gemini/poi-review-summary", async (request, reply) => {
    if (!guard(reply)) return;
    const parsed = bodyPoiReviewSummary.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    try {
      const globalCorpus = request.user
        ? await loadGlobalUserReviewCorpus(request.user.id)
        : [];
      return await geminiPoiReviewSummaryServer(
        parsed.data.poi,
        parsed.data.userComments,
        globalCorpus,
        parsed.data.interestHints,
        opts.geminiApiKey,
        opts.geminiModel,
        request.log,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gemini error";
      request.log.error(e);
      return reply.code(502).send({ error: msg });
    }
  });

  /** POI 사진은 Gemini 검색을 쓰지 않음 — 클라이언트는 emoji 플레이스홀더만 사용. */
  app.post("/ai/poi-photo", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const parsed = bodyPoi.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid body", details: parsed.error.flatten() });
    }
    return { url: null };
  });
};
