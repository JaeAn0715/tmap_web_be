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
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

function extractCandidateText(json: GeminiResp): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

/** Strip markdown fences / prose wrapper and return JSON object substring. */
export function extractJsonObjectFromText(text: string): string {
  let t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenced) t = fenced[1].trim();
  if (t.startsWith("{")) return t;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

export class GeminiJsonParseError extends Error {
  readonly rawPreview: string;

  constructor(rawPreview: string) {
    super("Gemini JSON parse failed");
    this.name = "GeminiJsonParseError";
    this.rawPreview = rawPreview;
  }
}

export function parseGeminiJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new GeminiJsonParseError("");
  const attempts = [trimmed, extractJsonObjectFromText(trimmed)];
  const seen = new Set<string>();
  for (const candidate of attempts) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* try next */
    }
  }
  throw new GeminiJsonParseError(trimmed.slice(0, 240));
}

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

async function callGeminiGenerateOnce(
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
    throw new GeminiHttpError(res.status, json.error?.message ?? res.statusText);
  }
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked: ${json.promptFeedback.blockReason}`);
  }
  const text = extractCandidateText(json);
  if (!text) throw new Error("Gemini empty response");
  const finishReason = json.candidates?.[0]?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new GeminiJsonParseError(text.slice(0, 240));
  }
  return text;
}

/** Gemini HTTP 5xx — 동일 모델 1회 재시도 대상. */
export class GeminiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`Gemini ${status}: ${message}`);
    this.name = "GeminiHttpError";
    this.status = status;
  }
}

type CallGeminiGenerateOptions = {
  log?: PoiReviewSummaryPipelineLog;
  /** true면 JSON 파싱까지 성공해야 반환 (POI 요약용). */
  requireJson?: boolean;
};

const GEMINI_5XX_MAX_ATTEMPTS = 2;

function shouldRetryGemini5xx(err: unknown): boolean {
  return err instanceof GeminiHttpError && err.status >= 500;
}

async function callGeminiGenerate(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  opts?: CallGeminiGenerateOptions,
): Promise<string> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= GEMINI_5XX_MAX_ATTEMPTS; attempt++) {
    try {
      const text = await callGeminiGenerateOnce(apiKey, model, body);
      if (opts?.requireJson) {
        parseGeminiJsonText(text);
      }
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < GEMINI_5XX_MAX_ATTEMPTS && shouldRetryGemini5xx(e)) {
        opts?.log?.info(
          {
            model,
            attempt,
            geminiStatus: e instanceof GeminiHttpError ? e.status : undefined,
            reason: e instanceof Error ? e.message : String(e),
          },
          "gemini_retry",
        );
        continue;
      }
      throw e;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Gemini request failed");
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
 * POI 상세용: 저장된 관심 명사(최대 10)를 반영한 단일 Gemini 호출.
 * `storedInterestNouns`는 리뷰 등록 시 서버가 미리 추출·저장한 목록이다(AI 요약과 분리).
 * `userComments`는 **현재 POI** 노트 원문으로, 모델이 **어느 관점을 중시할지** 추론할 때만 쓰인다.
 */
export async function geminiPoiReviewSummaryServer(
  poi: PoiInput,
  userComments: string[],
  storedInterestNouns: string[],
  interestHints: string[],
  apiKey: string,
  model: string,
  log?: PoiReviewSummaryPipelineLog,
): Promise<PoiReviewSummaryResult> {
  const comments = userComments.map(sanitizeCommentLine).filter((x): x is string => x != null);
  const nouns = storedInterestNouns.map((s) => s.trim()).filter(Boolean);
  const hints = interestHints.map((s) => s.trim()).filter(Boolean);

  log?.info(
    {
      step: 1,
      phase: "review_summary_input",
      poiId: poi.id,
      storedInterestNouns: nouns,
      poiLocalCommentLines: comments.length,
      hintCount: hints.length,
    },
    "poi_review_summary",
  );

  const commentsBlock =
    comments.length > 0
      ? comments
          .map((c, i) => `${i + 1}. ${c}`)
          .join("\n") +
          "\n\n(위 블록은 **내부 신호**다. 아래 최종 출력 규칙을 따른다.)"
      : "(이 POI에 대한 사용자 노트 원문 없음 — [저장된 관심 명사]·POI 메타·일반 방문자 상식만으로 서술한다.)";

  const nounsBlock =
    nouns.length > 0
      ? nouns.join(", ")
      : hints.length > 0
        ? `(저장된 관심 명사 없음 — 검색·의도 힌트 참고: ${hints.join(", ")})`
        : "(없음 — 일반 방문자 관점으로 균형 있게 서술)";

  const nounPriorityRule =
    nouns.length > 0
      ? `- **[저장된 관심 명사]** 중 이 POI 업종·메타와 **관련 있는 주제**가 있으면 pros/cons **앞쪽에서** 다룬다. 관련 주제가 없으면 일반 방문자 관점의 균형 잡힌 요약을 쓴다.`
      : hints.length > 0
        ? `- 저장된 관심 명사가 없으므로 [검색·의도 힌트]와 POI 메타를 참고해 일반 방문자 관점으로 서술한다.`
        : `- 저장된 관심 명사가 없으므로 일반 방문자 관점에서 동선·대기·가격·청결 등 균형 있게 서술한다.`;

  const prompt = `당신은 한국 장소(POI)에 대한 **리뷰 성격의 장단점 요약**을 작성한다. 최종 JSON의 pros·cons·highlightTerms는 **앱에 노출되는 사용자 대면 문구**이며, 사용자가 과거에 적어 둔 **노트·코멘트 원문이 그대로 또는 간접적으로 드러나서는 안 된다**.

역할 분리:
- **[저장된 관심 명사]**: 이 사용자가 **여러 리뷰·노트에서 자주 쓴 명사** 목록(최대 10). 장소를 고를 때 무엇을 중시하는지의 힌트.
- **[이 POI 비공개 노트 원문]**: **오직 내부용**. 이 사람이 **이 장소**에 대해 무엇을 중요하게 보는지(우선순위·관심 축)를 **추론**하는 데만 쓴다. **요약 본문의 근거 문장·인용·패러프레이즈·1인칭·노트에만 나오는 구체 표현으로 되살리지 말 것.**
- **[POI]**: 공개 메타(이름·주소·업종 등)만 **사실의 기준**으로 삼을 수 있다. 메타에 없는 구체 사실은 노트 내용을 빌려와 단정하지 말고, **업종·일반 상식** 수준으로만 말한다.

작성 규칙:
${nounPriorityRule}
- pros/cons는 **화자 없는 제3자/일반 방문자 톤**이다. "내가 썼다", "노트에", "메모대로" 등 **사용자 기록을 언급하거나 암시하지 말 것**.
- **[이 POI 비공개 노트 원문]**에서 단어·구절을 **복사하거나 살짝 바꿔 붙이지 말 것**(표절·유사 인용 금지).
- **이 POI**에 대해 메타·일반 상식으로도 말할 수 없는 세부는 **단정하지 않는다**.
- 웹 검색 도구는 사용하지 않는다.
- **괄호 부연·메타 설명 금지**(반각·전각). "제공된 정보", "입력으로는" 같은 **데이터·프롬프트 메타 코멘트 금지**.

[POI]
${poiContextLines(poi)}
위도/경도: ${poi.lat}, ${poi.lng}

[이 POI 비공개 노트 원문 — 사용자에게 비노출. 관점 추론 전용; pros/cons에 반영·인용 금지]
${commentsBlock}

[저장된 관심 명사 — 리뷰 등록 시 서버가 미리 추출·저장]
${nounsBlock}

출력 (JSON만, 마크다운 없음):
- pros: 한국어 평문, ${REVIEW_PROS_CONS_MAX}자 이하, 장점·긍정 요약. **노트 원문과 겹치는 표현 없음.** 마크다운 볼드 금지. **괄호 부연·메타 문구 없음.**
- cons: 한국어 평문, ${REVIEW_PROS_CONS_MAX}자 이하, 단점·유의사항. 동일.
- highlightTerms: ${HL_MIN}~${HL_MAX}개. 각 ${HL_TERM_MIN}~${HL_TERM_MAX}자. **반드시 pros 또는 cons에 부분 문자열로 포함**될 것. **노트에만 있던 짧은 구절·고유 표현과 동일·유사한 항목은 넣지 말 것** — pros/cons 안에서 새로 쓴 일반 문장 조각만 고른다. 가능하면 [저장된 관심 명사]와 맞닿는 일반 표현을 우선한다.

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

  const text = await callGeminiGenerate(apiKey, model, body, {
    log,
    requireJson: true,
  });
  const raw = parseGeminiJsonText(text) as {
    pros?: string;
    cons?: string;
    highlightTerms?: string[];
  };

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
      step: 2,
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

/** @internal unit tests only */
export async function callGeminiGenerateForTest(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
  requireJson = false,
): Promise<string> {
  return callGeminiGenerate(apiKey, model, body, { requireJson });
}
