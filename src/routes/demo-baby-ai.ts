import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../plugins/auth.js";
import {
  rebuildUserInterestNounsFromCorpus,
  type InterestNounEntry,
} from "../services/user-interest-nouns.js";

/** Stable id so share link `#/c/babyAiDemo012345678901234567890` matches docs. */
export const DEMO_BABY_AI_CLUSTER_ID = "babyAiDemo012345678901234567890";

/** AI 데모 시드당 생성하는 리뷰(노트) 최대 건수. */
export const DEMO_BABY_AI_NOTE_LIMIT = 10;

/** 시드 리뷰·POI 메타에 넣지 않을 금지어(명사 추출·요약 노이즈 방지). */
const FORBIDDEN_DEMO_REVIEW_WORDS = /데모|맛집/u;

const DEFAULT_TOPICS = ["유아의자", "유모차", "이유식"] as const;

/** 실제 장소명처럼 보이는 샘플 이름(「데모」「맛집」 미사용). */
const DEMO_POI_NAME_POOL = [
  "청계한상",
  "종로골목식당",
  "마포온누리식당",
  "연남브런치하우스",
  "성수동밥상",
  "을지로국밥",
  "광화문뜰식당",
  "한남동테이블",
  "이태원정식",
  "용산역앞식당",
] as const;

const postBodySchema = z.object({
  /** If set, only this Google-linked email may run the seed (extra guard). */
  expectEmail: z.string().email().optional(),
  /** 한 POI당 한 노트씩 순환·조합할 토픽 목록. 미내면 기본 3종. */
  topics: z.array(z.string().min(1).max(40)).min(1).max(20).optional(),
  /** true면 POI 인덱스까지 시드에 넣어 같은 토픽이라도 문장 편차를 키움. */
  varyCommentsPerPoi: z.boolean().optional().default(true),
});

/** `POST /demo/baby-ai-summary-seed` 성공 응답 형태(프론트 계약 유지). */
export type DemoBabyAiSeedResponse = {
  clusterId: string;
  clusterName: string;
  poiCount: number;
  notesCreated: number;
  samplePoi: {
    id: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    category: string;
  };
  sampleUserComments: string[];
  /** 시드 직후 전체 리뷰 코퍼스 기준으로 재계산한 관심 명사(최대 10). */
  interestNouns: InterestNounEntry[];
};

type PoiLite = {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
};

function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function containsForbiddenDemoWords(text: string): boolean {
  return FORBIDDEN_DEMO_REVIEW_WORDS.test(text);
}

function fillTpl(tpl: string, p: PoiLite): string {
  const shortAddr = p.address.length > 14 ? `${p.address.slice(0, 14)}…` : p.address;
  return tpl
    .replaceAll("{name}", p.name)
    .replaceAll("{cat}", p.category)
    .replaceAll("{addr}", shortAddr);
}

/** 시드용 POI·리뷰 문장에 금지어가 없는지 검사. */
function isValidDemoReviewText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  return !containsForbiddenDemoWords(t);
}

/** 토픽별 1~2문장 템플릿. 같은 POI에서 해시로 골라 겹치지 않게 쓴다. */
const NOTE_TEMPLATES_BY_TOPIC: Record<string, string[]> = {
  유아의자: [
    "{name} 아기의자는 창가 쪽 테이블 위주였고, 유아 동반석은 따로 안내해 주셨다.",
    "{name}에서 유아용 의자는 두세 개뿐이라 피크 시간엔 빨리 소진될 수 있겠다.",
    "{cat} 업종인 {name}은 아기의자 높이가 살짝 낮아 키 큰 아이에게는 불편할 수 있다.",
    "{name} 계단 입구 쪽 자리는 아기의자 배치가 어려워 보였다.",
    "{name} 직원분이 아기의자부터 매트까지 순서대로 챙겨 주셔서 첫 방문에도 정리가 빨랐다.",
    "{name} 유아의자는 있으나 좌석 간격이 좁아 의자를 끌어당기기 애매한 테이블이 있었다.",
    "{name} 예약 시 유아 동반·의자 요청을 미리 하는 편이 안전해 보였다.",
    "{name} 화장실 가는 동선이 길어 아기의자에서 잠깐 비울 때 동선을 미리 짜는 게 좋겠다.",
    "{name}은 웨이팅이 길어지면 아기의자 확보 전에 테이블만 배정되는 경우가 있을 수 있다.",
    "{name} 코너석은 아기의자 각도 조절이 자유로워 수유 자세에 유리했다.",
    "{name}에서 아기의자 고정 클립이 한쪽만 느슨해 보여 사용 전 확인이 필요했다.",
    "{name}은 실내 소음이 커서 아기가 잠들기엔 다소 부담스러울 수 있다.",
    "{name} 포장 주문 대기 구역이 좁아 유아의자를 접었다 펼 때 주의가 필요했다.",
    "{name} 바닥이 미끄러운 편이라 아기의자 받침이 잘 고정되는지 확인하는 게 좋다.",
    "{name} 단체석 근처는 아기의자를 놓기엔 통로 폭이 부족해 보였다.",
    "{name} 직원 응대는 빨랐으나 아기의자 재고 확인에 한두 분 걸렸다.",
    "{addr} 근처 {name}은 아기의자는 충분했지만 햇빛이 강한 자리는 눈부실 수 있다.",
    "{name}에서 유아의자와 식탁 높이 차가 커 수저 사용 연습 중인 아이에게는 각도 조절이 필요했다.",
  ],
  유모차: [
    "{name} 입구 계단이 있어 유모차 접은 채로 내려야 했다.",
    "{name} 매장 내 통로가 좁아 유모차를 세우고 지나가기엔 여유가 부족해 보였다.",
    "{name} 주차장 엘리베이터까지 거리가 있어 유모차 챙길 때 동선을 미리 보는 게 좋다.",
    "{name}은 웨이팅 공간이 실외라 비 오는 날 유모차 커버가 필요했다.",
    "{name} 계단 옆 경사로가 있었지만 각도가 급해 유모차 브레이크를 꼭 잡아야 했다.",
    "{name}에서 유모차 보관을 입구에 맡기는 형태라 귀중품은 최소화하는 편이 낫겠다.",
    "{name} 좌석까지 복도가 길어 유모차를 접었다 펼 때 한 번에 정리하기 어려웠다.",
    "{name} 직원이 유모차 동선을 안내해 주어 첫 방문에도 혼잡을 줄일 수 있었다.",
    "{name}은 피크 타임에 유모차끼리 엇갈리기 쉬워 통과에 시간이 걸렸다.",
    "{name} 매장 문턱이 높아 유모차 앞바퀴를 살짝 들어 올려야 했다.",
    "{cat}인 {name}은 유모차 대신 아기띠를 쓰는 손님이 더 많아 보였다.",
    "{name} 테이블 아래 공간이 좁아 유모차를 옆에 세워두기엔 불편했다.",
    "{name} 화장실 앞 복도가 협소해 유모차를 잠시 두기 어려웠다.",
    "{name}에서 유모차 접기 전 폴딩 크기를 안내해 주셔서 준비가 수월했다.",
    "{addr} 쪽 {name}은 실외 테라스가 있어 유모차를 그대로 두고 앉기엔 좋았다.",
    "{name} 유모차 세척을 위한 물티슈는 카운터에서 받을 수 있었다.",
    "{name}은 좌석이 계단 위라 유모차를 아래에 두고 올라가야 했다.",
    "{name} 매장 내 유턴 구간이 많아 유모차 방향 전환에 여유가 필요했다.",
  ],
  이유식: [
    "{name}에서 이유식 데우기는 카운터에 맡기는 방식이었다.",
    "{name}은 전자레인지 사용이 제한적이라 이유식 병만 데울 수 있었다.",
    "{name} 직원이 이유식 온도 맞추는 데 익숙해 보여 맡기기 편했다.",
    "{cat} 업종인 {name}은 이유식 외 간식류는 별도 주문이 필요했다.",
    "{name} 이유식용 물은 정수기 옆에서 직접 받을 수 있었다.",
    "{name}에서 이유식 조리 지원은 없고 데우기만 가능했다.",
    "{name}은 이유식 파우치를 주문해 함께 먹는 가족이 많아 보였다.",
    "{name} 아이 연령대가 다양해 이유식 단계별로 질문이 이어졌다.",
    "{name}에서 이유식 시간이 길어질 경우 웨이팅이 겹칠 수 있어 예약이 유리해 보였다.",
    "{name}은 이유식 후 설거지 공간이 협소해 일회용 용기를 챙기는 편이 낫다.",
    "{name} 이유식 데울 때 전용 트레이를 제공해 위생적으로 느껴졌다.",
    "{name}에서 이유식 재료 알레르기 문의에 친절히 답해 주셨다.",
    "{name}은 이유식과 함께 주문한 반찬이 나오는 속도가 달라 순서 조절이 필요했다.",
    "{addr} 근처 {name}은 이유식 외 유아 간식 메뉴가 소량 있었다.",
    "{name} 이유식 데우기 대기 줄이 짧지 않아 피크엔 여유 시간을 두는 게 좋다.",
    "{name}에서 이유식용 가위·스푼은 개인 지참을 권장한다고 안내했다.",
    "{name}은 실내 온도가 높아 이유식 상하기 전에 빨리 먹이는 편이 좋겠다.",
    "{name} 이유식 관련 질문에 메뉴판에 표기가 없어 직원 확인이 필요했다.",
  ],
};

function templatesForTopic(topic: string): string[] {
  const t = NOTE_TEMPLATES_BY_TOPIC[topic];
  if (t?.length) return [...t];
  const generic = NOTE_TEMPLATES_BY_TOPIC["유아의자"]!.map(
    (s) => s.replaceAll("유아의자", topic).replaceAll("아기의자", topic),
  );
  return generic;
}

function takeUpToThreeDistinct(preferred: string[], fallbackPool: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of preferred) {
    if (out.length >= 3) break;
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  for (const s of fallbackPool) {
    if (out.length >= 3) break;
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function pickUniqueNoteText(
  p: PoiLite,
  poiIdx: number,
  noteIdx: number,
  topic: string,
  varyCommentsPerPoi: boolean,
  usedOnThisPoi: Set<string>,
): string {
  const pool = templatesForTopic(topic);
  const varyPart = varyCommentsPerPoi ? `|p${poiIdx}` : "";
  let h = stableHash(`${p.id}|n${noteIdx}|${topic}${varyPart}`);
  for (let attempt = 0; attempt < pool.length * 2; attempt++) {
    const idx = (h + attempt) % pool.length;
    const text = fillTpl(pool[idx]!, p).replace(/\s+/g, " ").trim();
    if (isValidDemoReviewText(text) && !usedOnThisPoi.has(text)) {
      usedOnThisPoi.add(text);
      return text;
    }
  }
  const fallback = fillTpl(
    `${topic} 동반 방문 기준으로 통로·좌석·직원 응대가 무난했고 재방문을 검토해 볼 만하다.`,
    p,
  );
  if (!isValidDemoReviewText(fallback)) {
    throw new Error("Demo review template produced forbidden words");
  }
  usedOnThisPoi.add(fallback);
  return fallback;
}

function buildDemoPois(count: number): PoiLite[] {
  const baseLat = 37.5665;
  const baseLng = 126.978;
  const pois: PoiLite[] = [];
  for (let i = 0; i < count; i++) {
    const id = `demoBabyPoi${String(i).padStart(3, "0")}`;
    const name = DEMO_POI_NAME_POOL[i % DEMO_POI_NAME_POOL.length]!;
    pois.push({
      id,
      name,
      address: `서울 종로구 샘플로 ${i + 1}길 ${10 + i}`,
      lat: baseLat + (i % 10) * 0.002,
      lng: baseLng + Math.floor(i / 10) * 0.002,
      category: "음식점",
    });
  }
  return pois;
}

export const demoBabyAiRoutes: FastifyPluginAsync = async (app) => {
  app.post("/demo/baby-ai-summary-seed", async (request, reply) => {
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

    const topics =
      parsed.data.topics && parsed.data.topics.length > 0
        ? parsed.data.topics
        : [...DEFAULT_TOPICS];
    const varyCommentsPerPoi = parsed.data.varyCommentsPerPoi;

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

    const pois = buildDemoPois(DEMO_BABY_AI_NOTE_LIMIT);
    const mapCenter = { lat: 37.5665, lng: 126.978 };
    const userName = user.name ?? user.email ?? "User";

    const noteRows: Array<{
      clusterId: string;
      poiId: string;
      userId: string;
      userName: string;
      text: string;
    }> = [];

    for (let poiIdx = 0; poiIdx < pois.length; poiIdx++) {
      const p = pois[poiIdx]!;
      const used = new Set<string>();
      const topic = topics[poiIdx % topics.length]!;
      const text = pickUniqueNoteText(p, poiIdx, 0, topic, varyCommentsPerPoi, used);
      noteRows.push({
        clusterId: DEMO_BABY_AI_CLUSTER_ID,
        poiId: p.id,
        userId: user.id,
        userName,
        text,
      });
    }

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

    const interestNouns = await rebuildUserInterestNounsFromCorpus(user.id);

    const first = pois[0]!;
    const firstPoiNotes = noteRows.filter((n) => n.poiId === first.id).map((n) => n.text);
    const allTextsInOrder = noteRows.map((n) => n.text);
    const sampleUserComments = takeUpToThreeDistinct(firstPoiNotes, allTextsInOrder);

    const body: DemoBabyAiSeedResponse = {
      clusterId: DEMO_BABY_AI_CLUSTER_ID,
      clusterName: "실험용",
      poiCount: pois.length,
      notesCreated: noteRows.length,
      samplePoi: first,
      sampleUserComments,
      interestNouns,
    };
    return body;
  });
};
