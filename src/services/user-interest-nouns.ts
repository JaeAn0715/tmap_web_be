import { prisma } from "../lib/prisma.js";
import { extractNounCountsFromText, extractNounCountsFromLines } from "../lib/ko-noun-extract.js";
import { loadGlobalUserReviewCorpus } from "./user-interest-corpus.js";

export const MAX_USER_INTEREST_NOUNS = 10;

export type InterestNounEntry = {
  term: string;
  count: number;
};

function parseInterestNouns(raw: unknown): InterestNounEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: InterestNounEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const term = "term" in item ? String((item as { term: unknown }).term).trim() : "";
    const count = "count" in item ? Number((item as { count: unknown }).count) : NaN;
    if (!term || term.length < 2 || term.length > 16) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    out.push({ term, count: Math.floor(count) });
  }
  return out;
}

export function mergeInterestNounEntries(
  current: InterestNounEntry[],
  delta: Map<string, number>,
): InterestNounEntry[] {
  if (delta.size === 0) return current.slice(0, MAX_USER_INTEREST_NOUNS);
  const map = new Map(current.map((e) => [e.term, e.count]));
  for (const [term, add] of delta) {
    if (add <= 0) continue;
    map.set(term, (map.get(term) ?? 0) + add);
  }
  return [...map.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term, "ko"))
    .slice(0, MAX_USER_INTEREST_NOUNS);
}

export async function loadUserTopInterestNouns(
  userId: string,
  limit = MAX_USER_INTEREST_NOUNS,
): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { interestNouns: true },
  });
  const entries = parseInterestNouns(user?.interestNouns);
  return entries.slice(0, limit).map((e) => e.term);
}

export async function loadUserInterestNounEntries(userId: string): Promise<InterestNounEntry[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { interestNouns: true },
  });
  return parseInterestNouns(user?.interestNouns);
}

/** 리뷰·노트 등록 직후 호출. AI 요약 파이프라인과 분리된다. */
export async function ingestReviewTextForInterestNouns(
  userId: string,
  text: string,
): Promise<InterestNounEntry[]> {
  const delta = extractNounCountsFromText(text);
  if (delta.size === 0) {
    return loadUserInterestNounEntries(userId);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { interestNouns: true },
  });
  if (!user) return [];

  const merged = mergeInterestNounEntries(parseInterestNouns(user.interestNouns), delta);
  await prisma.user.update({
    where: { id: userId },
    data: { interestNouns: merged },
  });
  return merged;
}

/** 사용자 전체 리뷰·노트 코퍼스에서 관심 명사 상위 10개를 처음부터 다시 계산한다. */
export async function rebuildUserInterestNounsFromCorpus(
  userId: string,
): Promise<InterestNounEntry[]> {
  const lines = await loadGlobalUserReviewCorpus(userId);
  const delta = extractNounCountsFromLines(lines);
  const merged = mergeInterestNounEntries([], delta);
  await prisma.user.update({
    where: { id: userId },
    data: { interestNouns: merged },
  });
  return merged;
}
