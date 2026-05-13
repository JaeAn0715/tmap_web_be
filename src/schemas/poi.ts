import { z } from "zod";

/** POI snapshot aligned with frontend ClusterPayload expectations */
export const poiSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  address: z.string(),
  roadAddress: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  category: z.string().optional(),
  bizCategory: z.string().optional(),
  tel: z.string().optional(),
  raw: z.unknown().optional(),
});

export type PoiInput = z.infer<typeof poiSchema>;

export const mapCenterSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
