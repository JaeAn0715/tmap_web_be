import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const jwtSecret = "test-jwt-secret-minimum-32-chars!!";
const googleClientId = "";

async function authAs(googleSub: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/google",
    payload: { credential: `test:${googleSub}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string };
  return body.token;
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    jwtSecret,
    googleClientId,
    corsOrigin: true,
    geminiApiKey: "",
    geminiModel: "gemini-2.5-flash-lite",
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const samplePoi = (id: string) => ({
  id,
  name: "Place",
  address: "Seoul",
  lat: 37.5,
  lng: 127.0,
});

describe("API", () => {
  it("creates cluster as owner, allows public GET, blocks non-owner PATCH", async () => {
    const tokenA = await authAs("owner-a");

    const create = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "Trip",
        mapCenter: { lat: 37, lng: 127 },
        mapZoom: 12,
        pois: [samplePoi("p1")],
      },
    });
    expect(create.statusCode).toBe(200);
    const cluster = create.json() as { id: string; ownerId: string; feedback: unknown };
    expect(cluster.id.length).toBeGreaterThanOrEqual(16);
    expect(cluster.feedback).toBeDefined();

    const pub = await app.inject({ method: "GET", url: `/clusters/${cluster.id}` });
    expect(pub.statusCode).toBe(200);

    const tokenB = await authAs("user-b");
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/clusters/${cluster.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: "Hacked" },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("dedupes rapid duplicate cluster creates (same payload within window)", async () => {
    const token = await authAs("dedupe-owner");
    const payload = {
      name: "Dedupe Trip",
      mapCenter: { lat: 37.1, lng: 127.1 },
      mapZoom: 13,
      pois: [samplePoi("pd-1"), samplePoi("pd-2")],
    };
    const a = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(a.statusCode).toBe(200);
    const b = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(b.statusCode).toBe(200);
    const ja = a.json() as { id: string };
    const jb = b.json() as { id: string };
    expect(ja.id).toBe(jb.id);

    const list = await app.inject({
      method: "GET",
      url: "/me/clusters",
      headers: { authorization: `Bearer ${token}` },
    });
    const clusters = (list.json() as { clusters: { id: string; name: string }[] }).clusters;
    expect(clusters.filter((c) => c.id === ja.id).length).toBe(1);
  });

  it("poi-review-summary does not require auth (503 when Gemini key missing)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ai/gemini/poi-review-summary",
      payload: {
        poi: samplePoi("anon-poi"),
        userComments: [],
        interestHints: [],
      },
    });
    expect(res.statusCode).toBe(503);
  });

  it("allows shared recipient to like and note; owner can delete others note; blocks non-auth", async () => {
    const tokenOwner = await authAs("owner-like");
    const create = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${tokenOwner}` },
      payload: {
        name: "Shared",
        mapCenter: { lat: 37, lng: 127 },
        mapZoom: 11,
        pois: [samplePoi("poi-x")],
      },
    });
    const { id: clusterId } = create.json() as { id: string };

    const guestLike = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/poi-x/likes`,
    });
    expect(guestLike.statusCode).toBe(401);

    const tokenGuest = await authAs("guest-like");
    const like = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/poi-x/likes`,
      headers: { authorization: `Bearer ${tokenGuest}` },
    });
    expect(like.statusCode).toBe(200);
    const afterLike = like.json() as { feedback: Record<string, { likes: unknown[] }> };
    expect(afterLike.feedback["poi-x"].likes.length).toBe(1);

    const noteRes = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/poi-x/notes`,
      headers: { authorization: `Bearer ${tokenGuest}` },
      payload: { text: "hello" },
    });
    expect(noteRes.statusCode).toBe(200);
    const noteBody = noteRes.json() as { feedback: Record<string, { notes: { id: string }[] }> };
    const noteId = noteBody.feedback["poi-x"].notes[0].id;

    const ownerDel = await app.inject({
      method: "DELETE",
      url: `/clusters/${clusterId}/pois/poi-x/notes/${noteId}`,
      headers: { authorization: `Bearer ${tokenOwner}` },
    });
    expect(ownerDel.statusCode).toBe(200);
    const cleared = ownerDel.json() as { feedback: Record<string, { notes: unknown[] }> };
    expect(cleared.feedback["poi-x"].notes.length).toBe(0);
  });

  it("fork copies POIs without feedback", async () => {
    const tokenOwner = await authAs("fork-src");
    const create = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${tokenOwner}` },
      payload: {
        name: "Original",
        mapCenter: { lat: 1, lng: 2 },
        mapZoom: 10,
        pois: [samplePoi("f1")],
      },
    });
    const src = create.json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/clusters/${src.id}/pois/f1/likes`,
      headers: { authorization: `Bearer ${tokenOwner}` },
    });

    const tokenOther = await authAs("fork-dst");
    const fork = await app.inject({
      method: "POST",
      url: `/clusters/${src.id}/fork`,
      headers: { authorization: `Bearer ${tokenOther}` },
      payload: { name: "Copy" },
    });
    expect(fork.statusCode).toBe(200);
    const copy = fork.json() as {
      id: string;
      ownerId: string;
      name: string;
      feedback: Record<string, { likes: unknown[]; notes: unknown[] }>;
    };
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe("Copy");
    expect(copy.feedback["f1"].likes.length).toBe(0);
    expect(copy.feedback["f1"].notes.length).toBe(0);
  });

  it("subscribe / unfollow and saved-places / recent", async () => {
    const tokenA = await authAs("sub-a");
    const tokenB = await authAs("sub-b");

    const create = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "List",
        mapCenter: { lat: 0, lng: 0 },
        mapZoom: 9,
        pois: [samplePoi("s1")],
      },
    });
    const { id } = create.json() as { id: string };

    await app.inject({
      method: "POST",
      url: `/me/clusters/${id}/subscribe`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    const list = await app.inject({
      method: "GET",
      url: "/me/clusters",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const clusters = (list.json() as { clusters: { id: string }[] }).clusters;
    expect(clusters.some((c) => c.id === id)).toBe(true);

    await app.inject({
      method: "DELETE",
      url: `/me/clusters/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const list2 = await app.inject({
      method: "GET",
      url: "/me/clusters",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const clusters2 = (list2.json() as { clusters: { id: string }[] }).clusters;
    expect(clusters2.some((c) => c.id === id)).toBe(false);

    const sp = await app.inject({
      method: "PUT",
      url: "/me/saved-places",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { home: samplePoi("home1"), work: null },
    });
    expect(sp.statusCode).toBe(200);

    const recent = await app.inject({
      method: "POST",
      url: "/me/recent-destinations",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: samplePoi("r1"),
    });
    expect(recent.statusCode).toBe(200);
  });

  it("cluster notes: text-only POST, image+placeholder text, empty rejected, PATCH keeps images", async () => {
    const token = await authAs("note-img-user");
    const create = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "NoteImg",
        mapCenter: { lat: 37, lng: 127 },
        mapZoom: 12,
        pois: [samplePoi("n1")],
      },
    });
    const { id: clusterId } = create.json() as { id: string };

    const textOnly = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/n1/notes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "hello note" },
    });
    expect(textOnly.statusCode).toBe(200);
    const body1 = textOnly.json() as {
      feedback: Record<string, { notes: { text: string; imageUrls?: string[] }[] }>;
    };
    expect(body1.feedback.n1.notes[0].text).toBe("hello note");
    expect(body1.feedback.n1.notes[0].imageUrls).toBeUndefined();

    const httpsUrl = "https://example.com/photo.jpg";
    const imgNote = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/n1/notes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "(이미지)", imageUrls: [httpsUrl] },
    });
    expect(imgNote.statusCode).toBe(200);
    const body2 = imgNote.json() as {
      feedback: Record<string, { notes: { imageUrls?: string[] }[] }>;
    };
    const notes2 = body2.feedback.n1.notes;
    expect(notes2.some((n) => n.imageUrls?.includes(httpsUrl))).toBe(true);

    const empty = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/n1/notes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "   ", imageUrls: [] },
    });
    expect(empty.statusCode).toBe(400);

    const noteWithImg = notes2.find((n) => n.imageUrls?.includes(httpsUrl))!;
    const patchText = await app.inject({
      method: "PATCH",
      url: `/clusters/${clusterId}/pois/n1/notes/${noteWithImg.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "updated caption", imageUrls: [httpsUrl] },
    });
    expect(patchText.statusCode).toBe(200);
    const body3 = patchText.json() as {
      feedback: Record<string, { notes: { id: string; text: string; imageUrls?: string[] }[] }>;
    };
    const patched = body3.feedback.n1.notes.find((n) => n.id === noteWithImg.id)!;
    expect(patched.text).toBe("updated caption");
    expect(patched.imageUrls).toEqual([httpsUrl]);
  });

  it("cluster notes: rejects data:image URLs when ALLOW_CLUSTER_NOTE_DATA_IMAGE_URLS is not true", async () => {
    const token = await authAs("data-reject-user");
    const create = await app.inject({
      method: "POST",
      url: "/clusters",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "DataReject",
        mapCenter: { lat: 37, lng: 127 },
        mapZoom: 12,
        pois: [samplePoi("d1")],
      },
    });
    const { id: clusterId } = create.json() as { id: string };
    const tinyPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const res = await app.inject({
      method: "POST",
      url: `/clusters/${clusterId}/pois/d1/notes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "t", imageUrls: [tinyPng] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("personal POI notes: CRUD + list by poiId", async () => {
    const token = await authAs("personal-poi-user");
    const post = await app.inject({
      method: "POST",
      url: "/me/poi-notes",
      headers: { authorization: `Bearer ${token}` },
      payload: { poiId: "poi-abc", text: "my thought" },
    });
    expect(post.statusCode).toBe(200);
    const note = post.json() as { id: string; poiId?: string; text: string };
    expect(note.text).toBe("my thought");
    expect(note.id).toBeTruthy();

    const listAll = await app.inject({
      method: "GET",
      url: "/me/poi-notes",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listAll.statusCode).toBe(200);
    const all = listAll.json() as { notes: { id: string }[] };
    expect(all.notes.some((n) => n.id === note.id)).toBe(true);

    const listFilter = await app.inject({
      method: "GET",
      url: "/me/poi-notes?poiId=poi-abc",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listFilter.statusCode).toBe(200);
    const filtered = listFilter.json() as { notes: { id: string }[] };
    expect(filtered.notes.some((n) => n.id === note.id)).toBe(true);

    const patch = await app.inject({
      method: "PATCH",
      url: `/me/poi-notes/${note.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "updated" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { text: string }).text).toBe("updated");

    const other = await authAs("other-poi-user");
    const forbidden = await app.inject({
      method: "PATCH",
      url: `/me/poi-notes/${note.id}`,
      headers: { authorization: `Bearer ${other}` },
      payload: { text: "hack" },
    });
    expect(forbidden.statusCode).toBe(404);

    const del = await app.inject({
      method: "DELETE",
      url: `/me/poi-notes/${note.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
  });
});
