import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import type { PoiInput } from "../schemas/poi.js";

const REVIEW_PROS_CONS_MAX = 200;
const HL_MIN = 5;
const HL_MAX = 12;
const HL_TERM_MIN = 2;
const HL_TERM_MAX = 16;

const poiReviewSummarySchema = z.object({
  pros: z.string().max(REVIEW_PROS_CONS_MAX),
  cons: z.string().max(REVIEW_PROS_CONS_MAX),
  highlightTerms: z
    .array(z.string().min(HL_TERM_MIN).max(HL_TERM_MAX))
    .min(HL_MIN)
    .max(HL_MAX),
});

export type PoiReviewSummaryResult = z.infer<typeof poiReviewSummarySchema>;

/** Optional Fastify logger for multi-step POI review (terminal / log aggregation). */
export type PoiReviewSummaryPipelineLog = Pick<FastifyBaseLogger, "info">;

type GeminiResp = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

function endpoint(model: string, key: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
}

export function poiContextLines(poi: PoiInput): string {
  return [
    `이름: ${poi.name}`,
    poi.address && `지번 주소: ${poi.address}`,
    poi.roadAddress && `도로명 주소: ${poi.roadAddress}`,
    poi.category && `업종: ${poi.category}`,
    poi.bizCategory && `카테고리: ${poi.bizCategory}`,
    poi.tel && `전화: ${poi.tel}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function callGeminiGenerate(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(endpoint(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as GeminiResp;
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${json.error?.message ?? res.statusText}`);
  }
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked: ${json.promptFeedback.blockReason}`);
  }
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error("Gemini empty response");
  return text;
}

function stripMarkdownLite(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`+/g, "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop parenthetical asides `(…)` / `（…）` (non-nested segments; repeat until stable). */
function stripBalancedOuterParens(s: string, open: string, close: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) {
      depth++;
      continue;
    }
    if (ch === close) {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function stripParentheticalSegments(s: string): string {
  let cur = s;
  for (let n = 0; n < 16; n++) {
    const next =
      stripBalancedOuterParens(stripBalancedOuterParens(cur, "(", ")"), "（", "）");
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/\s{2,}/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
}

/** Remove common LLM meta-disclaimers about "provided input" (Korean). */
function stripReviewMetaDisclaimers(s: string): string {
  let t = s;
  const patterns: RegExp[] = [
    /\s*이\s*부분은\s*제공(?:된|할)?\s*정보[^.?!]*[.?!]?/gi,
    /\s*제공(?:된|할)?\s*정보(?:가|는|에)?\s*(?:없|부족|제한)[^.?!]*[.?!]?/gi,
    /\s*입력(?:으로|에)서(?:는)?\s*(?:알\s*수\s*없|확인\s*불가|명시되지)[^.?!]*[.?!]?/gi,
    /\s*별도(?:의)?\s*정보(?:가|는)\s*(?:없|제공되지)[^.?!]*[.?!]?/gi,
  ];
  for (const re of patterns) t = t.replace(re, " ");
  return t.replace(/\s{2,}/g, " ").trim();
}

function polishReviewSummarySentence(s: string): string {
  return stripReviewMetaDisclaimers(stripParentheticalSegments(stripMarkdownLite(s)));
}

function sanitizeCommentLine(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (t === "(이미지)" || t === " (이미지)") return null;
  const stripped = t.endsWith(" (이미지)") ? t.slice(0, -" (이미지)".length).trim() : t;
  return stripped || null;
}

function filterHighlightsInBody(terms: string[], pros: string, cons: string): string[] {
  const hay = pros + cons;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const t = raw.trim();
    if (t.length < HL_TERM_MIN || t.length > HL_TERM_MAX) continue;
    if (!hay.includes(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function collectFallbackTerms(body: string, seen: Set<string>): string[] {
  const added: string[] = [];
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    try {
      const seg = new Intl.Segmenter("ko", { granularity: "word" });
      for (const { segment, isWordLike } of seg.segment(body)) {
        if (!isWordLike) continue;
        const s = segment.trim();
        if (s.length < HL_TERM_MIN || s.length > HL_TERM_MAX) continue;
        if (!body.includes(s)) continue;
        if (seen.has(s)) continue;
        seen.add(s);
        added.push(s);
        if (added.length >= 24) return added;
      }
    } catch {
      /* ignore */
    }
  }
  for (const part of body.split(/[\s,./·…:]+/)) {
    const s = part.trim();
    if (s.length < HL_TERM_MIN || s.length > HL_TERM_MAX) continue;
    if (!body.includes(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    added.push(s);
    if (added.length >= 24) break;
  }
  return added;
}

function slidingWindowSubstrings(body: string, seen: Set<string>, need: number): string[] {
  const out: string[] = [];
  if (need <= 0) return out;
  outer: for (let len = HL_TERM_MAX; len >= HL_TERM_MIN; len--) {
    for (let i = 0; i + len <= body.length; i++) {
      const slice = body.slice(i, i + len).trim();
      if (slice.length < HL_TERM_MIN || slice.length > HL_TERM_MAX) continue;
      if (!body.includes(slice)) continue;
      if (/^[\s,.·…]+$/.test(slice)) continue;
      if (seen.has(slice)) continue;
      seen.add(slice);
      out.push(slice);
      if (out.length >= need) break outer;
    }
  }
  return out;
}

const STOPWORDS_KO = new Set([
  "있음",
  "없음",
  "그냥",
  "진짜",
  "좀",
  "너무",
  "정말",
  "하는",
  "되는",
  "같은",
  "이런",
  "그런",
  "있는",
  "없는",
  "하는데",
  "입니다",
  "했음",
  "같음",
]);

/** Heuristic: exclude tokens unlikely to be bare nouns (step-1 fallback only). */
function isLikelyNonNounKoToken(w: string): boolean {
  if (STOPWORDS_KO.has(w)) return true;
  if (/(해요|했어|습니다|ㅂ니다|었어요|아요|었음|였음|겠습니다|네요|죠)$/.test(w)) return true;
  if (/(하는|되는|있는|없는|같은|싶은|좋은|나쁜|많은|적은)$/.test(w)) return true;
  if (/(해서|하지만|려고|으면|는데|대서)$/.test(w)) return true;
  if (/다$/.test(w) && w.length <= 4) return true;
  return false;
}

/** Step-1 fallback: word frequency; noun-like tokens only (heuristic, no POS tagger). */
function fallbackFrequentTermsFromComments(comments: string[], max: number): string[] {
  const counts = new Map<string, number>();
  if (typeof Intl === "undefined" || !("Segmenter" in Intl)) return [];
  try {
    const seg = new Intl.Segmenter("ko", { granularity: "word" });
    for (const line of comments) {
      for (const { segment, isWordLike } of seg.segment(line)) {
        if (!isWordLike) continue;
        const w = segment.trim();
        if (w.length < 2 || w.length > 16) continue;
        if (isLikelyNonNounKoToken(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  } catch {
    return [];
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

const keywordExtractSchema = {
  type: "OBJECT",
  properties: {
    terms: {
      type: "ARRAY",
      items: { type: "STRING" },
      minItems: 0,
      maxItems: 24,
    },
  },
  required: ["terms"],
} as const;

const reviewAnglesSchema = {
  type: "OBJECT",
  properties: {
    angles: {
      type: "ARRAY",
      items: { type: "STRING" },
      minItems: 1,
      maxItems: 8,
    },
  },
  required: ["angles"],
} as const;

type InterestCorpusMode = "all_user_reviews" | "search_hints_only";

async function geminiExtractInterestNounsFromCorpus(
  lines: string[],
  mode: InterestCorpusMode,
  apiKey: string,
  model: string,
): Promise<string[]> {
  const block = lines.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const prompt =
    mode === "all_user_reviews"
      ? `역할: 사용자 취향 요약. 아래는 **동일 사용자**가 여러 장소에 남긴 **리뷰·노트 전체**(즐겨찾기 모음 공유 노트 + 개인 POI 메모 등)이다.

목표:
- 이 사람이 **목적지를 검색·선택할 때 중요하게 여길 만한 관심사**를 **명사·명사구**로만 정리하라.
  - **포함**: 일반명사, 고유명사, 복합명사(예: 유모차, 아기의자, 웨이팅, 주차).
  - **제외**: 동사·형용사·부사 단독, 활용형(했다, 좋아요 …), 관형사형(좋은, 많은 …), 감탄·무의미어.
- 반복·강조된 관심을 우선. **최대 20개**, 2~12자 위주, 중요도·반복도 높은 순.
- terms에는 **노트 원문 문장을 그대로 넣지 말 것**. 주제를 대표하는 **짧은 명사·명사구**만.

리뷰·노트:
${block}

출력: JSON만 { "terms": string[] } — **명사·명사구만**.`
      : `아래는 저장된 사용자 리뷰가 없을 때 쓰는 **검색·의도 힌트** 목록뿐이다. 이 힌트만으로 이 사용자가 장소를 고를 때 중요하게 볼 만한 관심을 **명사·명사구**로 추출하라. (최대 20개, 2~12자 위주)

힌트:
${block}

출력: JSON만 { "terms": string[] } — **명사·명사구만**.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: 400,
      responseMimeType: "application/json",
      responseSchema: keywordExtractSchema,
    },
  };
  const text = await callGeminiGenerate(apiKey, model, body);
  let raw: { terms?: string[] };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return [];
  }
  const terms = (raw.terms ?? [])
    .map((t) => String(t).trim())
    .filter((t) => t.length >= 2 && t.length <= 16);
  return [...new Set(terms)].slice(0, 20);
}

async function geminiBuildReviewAngles(
  terms: string[],
  hints: string[],
  apiKey: string,
  model: string,
): Promise<string[]> {
  const termsLine = terms.length
    ? terms.join(", ")
    : "(전역 리뷰·노트에서 뽑은 관심 명사 없음 — 힌트·일반만 사용)";
  const hintsLine = hints.length ? hints.map((h, i) => `${i + 1}. ${h}`).join("\n") : "(검색·의도 힌트 없음)";

  const prompt = `아래는 한 사용자의 **관심 명사 키워드**(**여러 장소에 남긴 리뷰·노트 전체**에서 요약한 **명사·명사구**)와 **최근 검색·의도 힌트**이다.

이런 관심을 가진 사람이 장소(음식점·카페·키즈 등) 리뷰를 볼 때 **특히 확인하고 싶어 할 관점**을 3~7개 bullet로 짧은 한국어 구로 제시하라. (예: 유모차 동선, 아기의자 수, 웨이팅, 주차, 소음, 위생 등 — 입력에 맞게 가변)
각 문장은 **일반 방문자에게 쓰는 조언 톤**으로, 사용자 원문 표현을 인용하지 말 것.

[키워드]
${termsLine}

[힌트]
${hintsLine}

출력: JSON만 { "angles": string[] } — 각 원소는 8~60자 정도의 구체적 관점 한 줄.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 500,
      responseMimeType: "application/json",
      responseSchema: reviewAnglesSchema,
    },
  };
  const text = await callGeminiGenerate(apiKey, model, body);
  let raw: { angles?: string[] };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    return [];
  }
  return (raw.angles ?? [])
    .map((a) => String(a).trim())
    .filter(Boolean)
    .slice(0, 8);
}

function ensureHighlightTerms(rawTerms: string[], pros: string, cons: string): string[] {
  const body = pros + cons;
  let terms = filterHighlightsInBody(rawTerms, pros, cons);
  const seen = new Set(terms);
  if (terms.length < HL_MIN) {
    for (const t of collectFallbackTerms(body, seen)) {
      terms.push(t);
      if (terms.length >= HL_MIN) break;
    }
  }
  if (terms.length < HL_MIN) {
    terms.push(...slidingWindowSubstrings(body, seen, HL_MIN - terms.length));
  }
  if (terms.length < HL_MIN) {
    for (let len = HL_TERM_MIN; len <= Math.min(HL_TERM_MAX, body.length); len++) {
      for (let i = 0; i + len <= body.length && terms.length < HL_MIN; i++) {
        const slice = body.slice(i, i + len).trim();
        if (slice.length < HL_TERM_MIN) continue;
        if (!body.includes(slice)) continue;
        if (seen.has(slice)) continue;
        seen.add(slice);
        terms.push(slice);
      }
    }
  }
  return terms.slice(0, HL_MAX);
}

/**
 * POI 상세용: 3단계 파이프라인
 * 1) **전역** 리뷰·노트 코퍼스에서 관심 **명사** 추출(없으면 검색 힌트만으로 추출) → 2) 리뷰 관점 → 3) pros/cons/highlightTerms.
 * `userComments`는 **현재 POI** 노트 원문으로, 모델이 **어느 관점을 중시할지** 추론할 때만 쓰인다. **최종 요약에는 노트 내용을 넣지 않는다**(프롬프트로 강제).
 * `globalUserReviewCorpus`는 1단계 전역 관심 추출용.
 * `log`가 있으면 각 단계 결과를 `info`로 남긴다(터미널).
 */
export async function geminiPoiReviewSummaryServer(
  poi: PoiInput,
  userComments: string[],
  globalUserReviewCorpus: string[],
  interestHints: string[],
  apiKey: string,
  model: string,
  log?: PoiReviewSummaryPipelineLog,
): Promise<PoiReviewSummaryResult> {
  const comments = userComments.map(sanitizeCommentLine).filter((x): x is string => x != null);
  const globalLines = globalUserReviewCorpus.map(sanitizeCommentLine).filter((x): x is string => x != null);
  const hints = interestHints.map((s) => s.trim()).filter(Boolean);

  let step1Terms: string[] = [];
  let step1Source: "global_corpus" | "search_hints" | "none" = "none";
  if (globalLines.length > 0) {
    step1Source = "global_corpus";
    try {
      step1Terms = await geminiExtractInterestNounsFromCorpus(globalLines, "all_user_reviews", apiKey, model);
    } catch {
      step1Terms = [];
    }
    if (step1Terms.length === 0) {
      step1Terms = fallbackFrequentTermsFromComments(globalLines, 20);
    }
  } else if (hints.length > 0) {
    step1Source = "search_hints";
    try {
      step1Terms = await geminiExtractInterestNounsFromCorpus(hints, "search_hints_only", apiKey, model);
    } catch {
      step1Terms = [];
    }
    if (step1Terms.length === 0) {
      step1Terms = fallbackFrequentTermsFromComments(hints, 20);
    }
  }
  log?.info(
    {
      step: 1,
      phase: "global_interest_nouns",
      poiId: poi.id,
      step1Source,
      terms: step1Terms,
      globalCorpusLines: globalLines.length,
      poiLocalCommentLines: comments.length,
      hintCount: hints.length,
    },
    "poi_review_summary",
  );

  let step2Angles: string[] = [];
  try {
    step2Angles = await geminiBuildReviewAngles(step1Terms, hints, apiKey, model);
  } catch {
    step2Angles = [];
  }
  if (step2Angles.length === 0) {
    step2Angles = [
      hints.length > 0
        ? `최근 검색·의도 힌트를 반영한 방문 관점에서 장단점을 쓴다. 힌트: ${hints.slice(0, 8).join(", ")}`
        : "일반 방문자 관점에서 동선·대기·가격대·청결·재방문 의사 등 균형 있게 장단점을 쓴다.",
    ];
  }
  log?.info(
    {
      step: 2,
      phase: "review_angles",
      poiId: poi.id,
      angles: step2Angles,
    },
    "poi_review_summary",
  );

  const commentsBlock =
    comments.length > 0
      ? comments
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n") +
          "\n\n(위 블록은 **내부 신호**다. 아래 최종 출력 규칙을 따른다.)"
      : "(이 POI에 대한 사용자 노트 원문 없음 — [전역 관심 키워드]·[리뷰 관점]·POI 메타·일반 방문자 상식만으로 서술한다.)";

  const anglesBlock = step2Angles.map((a, i) => `${i + 1}. ${a}`).join("\n");

  const prompt = `당신은 한국 장소(POI)에 대한 **리뷰 성격의 장단점 요약**을 작성한다. 최종 JSON의 pros·cons·highlightTerms는 **앱에 노출되는 사용자 대면 문구**이며, 사용자가 과거에 적어 둔 **노트·코멘트 원문이 그대로 또는 간접적으로 드러나서는 안 된다**.

역할 분리:
- **[전역 관심 키워드]**: 이 사용자가 **여러 장소에 남긴 기록 전체**에서 추정한 **명사·명사구** 수준의 관심사. 장소를 고를 때 무엇을 중시하는지의 힌트. **모든 POI 요약에 공통 적용**.
- **[이 POI 비공개 노트 원문]**: **오직 내부용**. 이 사람이 **이 장소**에 대해 무엇을 중요하게 보는지(우선순위·관심 축)를 **추론**하는 데만 쓴다. **요약 본문의 근거 문장·인용·패러프레이즈·1인칭·노트에만 나오는 구체 표현으로 되살리지 말 것.** 노트를 "요약의 재료"로 쓰지 말고, **일반 방문자에게 줄 조언**만 쓴다.
- **[리뷰 관점]**: 위 신호와 힌트를 바탕으로 **어떤 각도를 볼지** 정한 목록. pros/cons는 이 관점의 **일반화된 서술**로 채운다.
- **[POI]**: 공개 메타(이름·주소·업종 등)만 **사실의 기준**으로 삼을 수 있다. 메타에 없는 구체 사실은 노트 내용을 빌려와 단정하지 말고, **업종·일반 상식** 수준으로만 말한다.

작성 규칙:
- pros/cons는 **화자 없는 제3자/일반 방문자 톤**이다. "내가 썼다", "노트에", "메모대로" 등 **사용자 기록을 언급하거나 암시하지 말 것**.
- **[이 POI 비공개 노트 원문]**에서 단어·구절을 **복사하거나 살짝 바꿔 붙이지 말 것**(표절·유사 인용 금지). 노트가 특정 주제를 중시함을 알았다면, 그 주제는 **[전역 관심 키워드]·[리뷰 관점]·POI 메타**만으로 **새 문장**을 지어 다룬다.
- **[전역 관심 키워드]**와 맞닿는 주제가 있으면 **앞쪽에서 다룰 우선순위**로 삼을 수 있으나, 내용은 항상 **일반적·보편적 서술**로 유지한다.
- **이 POI**에 대해 메타·일반 상식으로도 말할 수 없는 세부는 **단정하지 않는다**.
- 웹 검색 도구는 사용하지 않는다.
- **괄호 부연·메타 설명 금지**(반각·전각). "제공된 정보", "입력으로는", "이 부분은 … 정보가" 같은 **데이터·프롬프트 메타 코멘트 금지**.

[POI]
${poiContextLines(poi)}
위도/경도: ${poi.lat}, ${poi.lng}

[이 POI 비공개 노트 원문 — 사용자에게 비노출. 관점 추론 전용; pros/cons에 반영·인용 금지]
${commentsBlock}

[전역 관심 키워드 — 1단계, 모든 POI에 공통 적용되는 명사·명사구]
${step1Terms.length ? step1Terms.join(", ") : "(없음 — 힌트·업종 일반만 사용)"}

[리뷰 관점 — 2단계]
${anglesBlock}

출력 (JSON만, 마크다운 없음):
- pros: 한국어 평문, ${REVIEW_PROS_CONS_MAX}자 이하, 장점·긍정 요약. **노트 원문과 겹치는 표현 없음.** 마크다운 볼드 금지. **괄호 부연·메타 문구 없음.**
- cons: 한국어 평문, ${REVIEW_PROS_CONS_MAX}자 이하, 단점·유의사항. 동일.
- highlightTerms: ${HL_MIN}~${HL_MAX}개. 각 ${HL_TERM_MIN}~${HL_TERM_MAX}자. **반드시 pros 또는 cons에 부분 문자열로 포함**될 것. **노트에만 있던 짧은 구절·고유 표현과 동일·유사한 항목은 넣지 말 것** — pros/cons 안에서 새로 쓴 일반 문장 조각만 고른다. 가능하면 [전역 관심 키워드]와 맞닿는 일반 표현을 우선한다.

규칙:
- **자기(이 사용자) 노트를 요약에 끌어다 쓰는 것 금지.**`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.55,
      maxOutputTokens: 900,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          pros: { type: "STRING" },
          cons: { type: "STRING" },
          highlightTerms: {
            type: "ARRAY",
            items: { type: "STRING" },
            minItems: HL_MIN,
            maxItems: HL_MAX,
          },
        },
        required: ["pros", "cons", "highlightTerms"],
      },
    },
  };

  const text = await callGeminiGenerate(apiKey, model, body);
  let raw: { pros?: string; cons?: string; highlightTerms?: string[] };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new Error("Gemini JSON parse failed");
  }

  const pros = polishReviewSummarySentence(String(raw.pros ?? "")).slice(0, REVIEW_PROS_CONS_MAX);
  const cons = polishReviewSummarySentence(String(raw.cons ?? "")).slice(0, REVIEW_PROS_CONS_MAX);
  if (!pros || !cons) throw new Error("Gemini returned empty pros or cons");

  const highlightTerms = ensureHighlightTerms(raw.highlightTerms ?? [], pros, cons);
  const checked = poiReviewSummarySchema.safeParse({ pros, cons, highlightTerms });
  if (!checked.success) {
    throw new Error(`Invalid review summary: ${checked.error.message}`);
  }

  log?.info(
    {
      step: 3,
      phase: "review_result",
      poiId: poi.id,
      pros: checked.data.pros,
      cons: checked.data.cons,
      highlightTerms: checked.data.highlightTerms,
    },
    "poi_review_summary",
  );

  return checked.data;
}

function extractImageUrl(text: string): string | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (/^NONE$/i.test(cleaned)) return null;
  const re =
    /(https?:\/\/[^\s'"<>)\]]+\.(?:jpe?g|png|webp|gif|avif)(?:\?[^\s'"<>)\]]*)?)/i;
  const m = cleaned.match(re);
  if (!m) return null;
  return m[1].replace(/[),.;]+$/, "");
}

export async function fetchPoiPhotoServer(
  poi: PoiInput,
  apiKey: string,
  model: string,
): Promise<string | null> {
  const ctx = [
    `이름: ${poi.name}`,
    poi.roadAddress && `주소: ${poi.roadAddress}`,
    !poi.roadAddress && poi.address && `지번: ${poi.address}`,
    poi.category && `업종: ${poi.category}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `Use Google Search to find a single direct, public image URL representing this Korean place. The URL must point straight at an image file (ends with .jpg, .jpeg, .png, or .webp; query strings are okay). Strongly prefer Wikimedia Commons, the place's official website, an official tourism page, or a major news/press photo. Avoid social-media or aggregator embed URLs that block hot-linking.

[POI]
${ctx}

Output rules:
- Output exactly one line.
- Output the URL only. No prose, no quotes, no markdown.
- If you cannot find a confident, public, hot-linkable image URL, output exactly: NONE`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
  };

  const res = await fetch(endpoint(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;

  const json = (await res.json()) as GeminiResp;
  if (json.promptFeedback?.blockReason) return null;
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  const fromText = extractImageUrl(text);
  if (fromText) return fromText;

  const chunks = json.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const c of chunks) {
    const u = c?.web?.uri;
    if (typeof u === "string") {
      const got = extractImageUrl(u);
      if (got) return got;
    }
  }
  return null;
}
