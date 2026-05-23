import { describe, expect, it } from "vitest";
import { extractNounCountsFromText } from "../src/lib/ko-noun-extract.js";
import {
  MAX_USER_INTEREST_NOUNS,
  mergeInterestNounEntries,
} from "../src/services/user-interest-nouns.js";

describe("mergeInterestNounEntries", () => {
  it("keeps at most 10 nouns sorted by count desc", () => {
    const current = Array.from({ length: 10 }, (_, i) => ({
      term: `n${i}`,
      count: 10 - i,
    }));
    const delta = new Map([["newterm", 1]]);
    const merged = mergeInterestNounEntries(current, delta);
    expect(merged).toHaveLength(MAX_USER_INTEREST_NOUNS);
    expect(merged[0].term).toBe("n0");
    expect(merged.some((e) => e.term === "newterm")).toBe(false);
    expect(merged[merged.length - 1].term).toBe("n9");
  });

  it("increments existing term counts", () => {
    const merged = mergeInterestNounEntries([{ term: "주차", count: 3 }], new Map([["주차", 2]]));
    expect(merged).toEqual([{ term: "주차", count: 5 }]);
  });

  it("adds new term when under capacity", () => {
    const merged = mergeInterestNounEntries([{ term: "주차", count: 3 }], new Map([["유모차", 2]]));
    expect(merged).toEqual([
      { term: "주차", count: 3 },
      { term: "유모차", count: 2 },
    ]);
  });
});

describe("extractNounCountsFromText", () => {
  it("extracts repeated noun-like tokens", () => {
    const counts = extractNounCountsFromText("주차 주차 편하고 유모차 동선 좋음");
    expect(counts.get("주차")).toBe(2);
    expect(counts.get("유모차")).toBe(1);
  });
});
