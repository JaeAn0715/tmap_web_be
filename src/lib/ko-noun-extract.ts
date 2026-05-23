const STOPWORDS_KO = new Set([
  "데모",
  "맛집",
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

/** Heuristic: exclude tokens unlikely to be bare nouns (no POS tagger). */
function isLikelyNonNounKoToken(w: string): boolean {
  if (STOPWORDS_KO.has(w)) return true;
  if (/(해요|했어|습니다|ㅂ니다|었어요|아요|었음|였음|겠습니다|네요|죠)$/.test(w)) return true;
  if (/(하는|되는|있는|없는|같은|싶은|좋은|나쁜|많은|적은)$/.test(w)) return true;
  if (/(해서|하지만|려고|으면|는데|대서)$/.test(w)) return true;
  if (/다$/.test(w) && w.length <= 4) return true;
  return false;
}

/** Word-frequency noun extraction from Korean text lines. */
export function extractNounCountsFromLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (typeof Intl === "undefined" || !("Segmenter" in Intl)) return counts;
  try {
    const seg = new Intl.Segmenter("ko", { granularity: "word" });
    for (const line of lines) {
      for (const { segment, isWordLike } of seg.segment(line)) {
        if (!isWordLike) continue;
        const w = segment.trim();
        if (w.length < 2 || w.length > 16) continue;
        if (isLikelyNonNounKoToken(w)) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }
  } catch {
    return counts;
  }
  return counts;
}

export function extractNounCountsFromText(text: string): Map<string, number> {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed === "(이미지)") return new Map();
  const stripped = trimmed.endsWith(" (이미지)")
    ? trimmed.slice(0, -" (이미지)".length).trim()
    : trimmed;
  if (!stripped) return new Map();
  return extractNounCountsFromLines([stripped]);
}
