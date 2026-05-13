import type { Cluster, ClusterNote, ClusterPoiLike, PoiPersonalNote, User } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { PoiInput } from "../schemas/poi.js";
import { imageUrlsFromDb } from "../schemas/cluster-notes.js";

export type ClusterLikeOut = { userId: string; userName: string; ts: number };
export type ClusterNoteOut = {
  id: string;
  userId: string;
  userName: string;
  text: string;
  ts: number;
  editedAt?: number;
  /** Present when non-empty; omitted for backwards compatibility with older clients. */
  imageUrls?: string[];
};

export type ClusterPayload = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  createdAt: number;
  updatedAt: number;
  mapCenter: { lat: number; lng: number };
  mapZoom: number;
  pois: PoiInput[];
  feedback: Record<string, { likes: ClusterLikeOut[]; notes: ClusterNoteOut[] }>;
};

function mapCenterFromJson(v: unknown): { lat: number; lng: number } {
  const o = v as { lat?: number; lng?: number };
  return { lat: Number(o.lat), lng: Number(o.lng) };
}

function likesToOut(l: ClusterPoiLike): ClusterLikeOut {
  return {
    userId: l.userId,
    userName: l.userName,
    ts: l.createdAt.getTime(),
  };
}

function notesToOut(n: ClusterNote): ClusterNoteOut {
  const urls = imageUrlsFromDb(n.imageUrls);
  return {
    id: n.id,
    userId: n.userId,
    userName: n.userName,
    text: n.text,
    ts: n.createdAt.getTime(),
    ...(n.editedAt ? { editedAt: n.editedAt.getTime() } : {}),
    ...(urls.length > 0 ? { imageUrls: urls } : {}),
  };
}

/** Same JSON keys as cluster `ClusterNote` for `tmap_web_fe` compatibility. */
export function personalPoiNoteToOut(n: PoiPersonalNote): ClusterNoteOut {
  const urls = imageUrlsFromDb(n.imageUrls);
  return {
    id: n.id,
    userId: n.userId,
    userName: n.userName,
    text: n.text,
    ts: n.createdAt.getTime(),
    ...(n.editedAt ? { editedAt: n.editedAt.getTime() } : {}),
    ...(urls.length > 0 ? { imageUrls: urls } : {}),
  };
}

export async function buildClusterPayload(
  cluster: Cluster & { owner: User },
): Promise<ClusterPayload> {
  const pois = cluster.pois as unknown as PoiInput[];
  const poiIds = new Set(pois.map((p) => p.id));

  const [likes, notes] = await Promise.all([
    prisma.clusterPoiLike.findMany({ where: { clusterId: cluster.id } }),
    prisma.clusterNote.findMany({ where: { clusterId: cluster.id } }),
  ]);

  const feedback: ClusterPayload["feedback"] = {};
  for (const id of poiIds) {
    feedback[id] = { likes: [], notes: [] };
  }

  for (const l of likes) {
    if (!feedback[l.poiId]) {
      feedback[l.poiId] = { likes: [], notes: [] };
    }
    feedback[l.poiId].likes.push(likesToOut(l));
  }
  for (const n of notes) {
    if (!feedback[n.poiId]) {
      feedback[n.poiId] = { likes: [], notes: [] };
    }
    feedback[n.poiId].notes.push(notesToOut(n));
  }

  return {
    id: cluster.id,
    name: cluster.name,
    ownerId: cluster.ownerId,
    ownerName: cluster.owner.name ?? cluster.owner.email ?? "Unknown",
    createdAt: cluster.createdAt.getTime(),
    updatedAt: cluster.updatedAt.getTime(),
    mapCenter: mapCenterFromJson(cluster.mapCenter),
    mapZoom: cluster.mapZoom,
    pois,
    feedback,
  };
}

export async function touchClusterUpdatedAt(clusterId: string): Promise<void> {
  await prisma.cluster.update({
    where: { id: clusterId },
    data: { updatedAt: new Date() },
  });
}
