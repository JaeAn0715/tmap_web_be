import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiHttpError,
  extractJsonObjectFromText,
  parseGeminiJsonText,
} from "../src/lib/gemini-server.js";

describe("GeminiHttpError", () => {
  it("preserves HTTP status for retry checks", () => {
    const err = new GeminiHttpError(503, "high demand");
    expect(err.status).toBe(503);
    expect(err.message).toContain("503");
  });
});

describe("parseGeminiJsonText", () => {
  it("parses fenced JSON", () => {
    const raw = parseGeminiJsonText(
      '```json\n{"pros":"a","cons":"b","highlightTerms":["a","b","c","d","e"]}\n```',
    ) as { pros: string };
    expect(raw.pros).toBe("a");
  });

  it("extracts embedded JSON object", () => {
    const slice = extractJsonObjectFromText('note {"pros":"x","cons":"y"} tail');
    expect(slice).toBe('{"pros":"x","cons":"y"}');
  });
});

describe("callGeminiGenerate retry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries once with the same model on 5xx", async () => {
    const { callGeminiGenerateForTest } = await import("../src/lib/gemini-server.js");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: "high demand" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "retry ok" }] } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const text = await callGeminiGenerateForTest(
      "key",
      "gemini-2.5-flash-lite",
      { contents: [] },
    );
    expect(text).toBe("retry ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.includes("gemini-2.5-flash-lite"))).toBe(true);
  });

  it("does not retry on 4xx", async () => {
    const { callGeminiGenerateForTest } = await import("../src/lib/gemini-server.js");
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "rate limit" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callGeminiGenerateForTest("key", "gemini-2.5-flash-lite", { contents: [] }),
    ).rejects.toBeInstanceOf(GeminiHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
