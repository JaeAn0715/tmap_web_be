import { prisma } from "../lib/prisma.js";

const DEFAULT_MAX_CLUSTER = 500;
const DEFAULT_MAX_PERSONAL = 300;
const MAX_LINE_CHARS = 600;
const MAX_TOTAL_LINES = 450;

/**
 * DB에 저장된 **해당 사용자**의 모든 공유 노트(즐겨찾기 모음) + 개인 POI 노트 본문을 모은다.
 * POI 리뷰 요약 1단계(전역 관심 명사)에만 사용한다.
 */
export async function loadGlobalUserReviewCorpus(userId: string): Promise<string[]> {
  const [clusterNotes, personalNotes] = await Promise.all([
    prisma.clusterNote.findMany({
      where: { userId },
      select: { text: true },
      orderBy: { createdAt: "desc" },
      take: DEFAULT_MAX_CLUSTER,
    }),
    prisma.poiPersonalNote.findMany({
      where: { userId },
      select: { text: true },
      orderBy: { createdAt: "desc" },
      take: DEFAULT_MAX_PERSONAL,
    }),
  ]);

  const out: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    if (out.length >= MAX_TOTAL_LINES) return;
    let s = raw.replace(/\s+/g, " ").trim();
    if (!s || s === "(이미지)") return;
    if (s.endsWith(" (이미지)")) s = s.slice(0, -" (이미지)".length).trim();
    if (!s) return;
    if (s.length > MAX_LINE_CHARS) s = s.slice(0, MAX_LINE_CHARS);
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  for (const n of clusterNotes) {
    if (out.length >= MAX_TOTAL_LINES) break;
    push(n.text);
  }
  for (const n of personalNotes) {
    if (out.length >= MAX_TOTAL_LINES) break;
    push(n.text);
  }

  return out;
}
