import { z } from "zod";
import { mapCenterSchema, poiSchema } from "./poi.js";

export const clusterCreateSchema = z.object({
  name: z.string().min(1),
  mapCenter: mapCenterSchema,
  mapZoom: z.number(),
  pois: z.array(poiSchema).min(1),
  id: z.string().min(16).max(64).optional(),
});

export const clusterPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    mapCenter: mapCenterSchema.optional(),
    mapZoom: z.number().optional(),
    pois: z.array(poiSchema).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "At least one field required" });

export const forkClusterSchema = z.object({
  name: z.string().min(1).optional(),
});
