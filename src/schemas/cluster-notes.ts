import { z } from "zod";

const MAX_NOTE_TEXT = 5000;
const MAX_IMAGES = 3;
/** Single image URL or data URL (when allowed). */
const MAX_HTTPS_URL_LEN = 4096;
const MAX_DATA_URL_LEN = 512 * 1024;

const dataImagePrefix = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/i;

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isAllowedHost(s: string, whitelist: string[] | null): boolean {
  if (!whitelist?.length) return true;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return whitelist.some((h) => h.toLowerCase() === host || host.endsWith(`.${h.toLowerCase()}`));
  } catch {
    return false;
  }
}

export function parseImageUrlWhitelist(): string[] | null {
  const raw = process.env.CLUSTER_NOTE_IMAGE_URL_ALLOWED_HOSTS?.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function allowDataImageUrls(): boolean {
  return process.env.ALLOW_CLUSTER_NOTE_DATA_IMAGE_URLS === "true";
}

function imageUrlItemSchema(opts: { allowData: boolean; hosts: string[] | null }) {
  return z
    .string()
    .min(1)
    .superRefine((val, ctx) => {
      if (val.startsWith("data:image/")) {
        if (!opts.allowData) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "data:image URLs are not allowed (set ALLOW_CLUSTER_NOTE_DATA_IMAGE_URLS=true for local dev only; production should use HTTPS upload URLs).",
          });
          return;
        }
        if (!dataImagePrefix.test(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "data: URL must be a base64 image (data:image/*;base64,...).",
          });
          return;
        }
        if (val.length > MAX_DATA_URL_LEN) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `data: URL exceeds ${MAX_DATA_URL_LEN} bytes; upload to storage and send HTTPS URLs instead.`,
          });
        }
        return;
      }
      if (val.length > MAX_HTTPS_URL_LEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "URL too long.",
        });
        return;
      }
      if (!isHttpsUrl(val)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each image URL must be http(s):// or (when enabled) data:image/...",
        });
        return;
      }
      if (opts.hosts && !isAllowedHost(val, opts.hosts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `URL host not in CLUSTER_NOTE_IMAGE_URL_ALLOWED_HOSTS whitelist.`,
        });
      }
    });
}

function noteImageUrlsField(allowData: boolean, hosts: string[] | null) {
  return z.array(imageUrlItemSchema({ allowData, hosts })).max(MAX_IMAGES).optional();
}

export function buildNoteCreateSchema() {
  const allowData = allowDataImageUrls();
  const hosts = parseImageUrlWhitelist();
  return z
    .object({
      text: z.string().max(MAX_NOTE_TEXT),
      imageUrls: noteImageUrlsField(allowData, hosts),
    })
    .superRefine((data, ctx) => {
      const urls = data.imageUrls ?? [];
      if (data.text.trim().length === 0 && urls.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide non-empty text and/or at least one imageUrls entry.",
          path: ["text"],
        });
      }
    });
}

/** PATCH: send `text` and/or `imageUrls`. If `imageUrls` is omitted, existing images are kept. */
export function buildNotePatchSchema() {
  const allowData = allowDataImageUrls();
  const hosts = parseImageUrlWhitelist();
  return z
    .object({
      text: z.string().max(MAX_NOTE_TEXT).optional(),
      imageUrls: noteImageUrlsField(allowData, hosts).optional(),
    })
    .superRefine((data, ctx) => {
      if (data.text === undefined && data.imageUrls === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "At least one of text or imageUrls is required for PATCH.",
        });
      }
    });
}

export type NoteCreateInput = z.infer<ReturnType<typeof buildNoteCreateSchema>>;
export type NotePatchInput = z.infer<ReturnType<typeof buildNotePatchSchema>>;

/** Normalize DB Json → string[] */
export function imageUrlsFromDb(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}
