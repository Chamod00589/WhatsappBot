const SPACE_BASE =
  process.env.BAG_IDENTIFY_BASE_URL ??
  "https://chamod482-openaiclip.hf.space";

/** Folder / stem labels that mean product-only (no color) in ImageIdentify. */
const PRODUCT_ONLY_NAMES = new Set([
  "_",
  "_product",
  "_all",
  "_group",
  "__product",
]);

export type BagMatch = {
  rank: number;
  product: string;
  /** Empty when only a product-only / multi-color catalog shot matched. */
  color: string;
  confidence: number;
  image_path: string;
};

export type MatchResponse = {
  matches: BagMatch[];
  error?: string;
};

function authHeaders(): HeadersInit {
  const token = process.env.HF_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Map an ImageIdentify filename stem (or color folder name) to the color label.
 *
 *   Pink          → Pink
 *   Pink__2       → Pink   (same-color extra shot)
 *   Pink__side    → Pink
 *   _1 / _all     → ""     (product-only / multi-color shot)
 */
export function normalizeIdentifyColorLabel(stem: string): string {
  const name = (stem || "").trim();
  if (!name) return "";
  if (PRODUCT_ONLY_NAMES.has(name) || name.startsWith("_")) return "";
  if (name.includes("__")) return name.split("__", 1)[0]!.trim();
  return name;
}

/**
 * Read color from a catalog path such as:
 *   products-images/Bloom Shoulder Bag/Pink__2.webp
 *   products-images/Bloom Shoulder Bag/Pink/01.webp
 *   products-images/Bloom Shoulder Bag/_1.webp
 */
export function colorFromIdentifyImagePath(imagePath: string): string {
  const parts = imagePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return "";

  const file = parts[parts.length - 1]!;
  const stem = file.replace(/\.[^.]+$/, "");
  const parent = parts[parts.length - 2]!;

  // Nested: …/<Product>/<Color>/<file>
  // Flat:    …/<Product>/<ColorOrTag>.ext  (parent is product name)
  const catalogIdx = parts.findIndex((p) => p === "products-images");
  const afterProduct =
    catalogIdx >= 0 ? parts.slice(catalogIdx + 2) : parts.slice(-2);

  if (afterProduct.length >= 2) {
    return normalizeIdentifyColorLabel(afterProduct[0]!);
  }

  // Flat file under product folder — ignore parent (product name)
  void parent;
  return normalizeIdentifyColorLabel(stem);
}

/**
 * Normalize Space match rows for WhatsApp / orders:
 * - strip Pink__2 → Pink
 * - treat _1 / _all as no color
 * - prefer path parse when the raw color still looks like a variant tag
 */
export function normalizeBagMatch(match: BagMatch): BagMatch {
  const raw = (match.color || "").trim();
  let color = normalizeIdentifyColorLabel(raw);
  const pathColor = match.image_path
    ? colorFromIdentifyImagePath(match.image_path)
    : "";

  if (raw.includes("__") || raw.startsWith("_")) {
    color = pathColor || color;
  } else if (!color && pathColor) {
    color = pathColor;
  }

  return { ...match, color };
}

export function normalizeMatchResponse(data: MatchResponse): MatchResponse {
  return {
    ...data,
    matches: (data.matches ?? []).map(normalizeBagMatch),
  };
}

/** One-shot match API (no Gradio SSE). */
export async function identifyBag(
  file: Blob | Buffer,
  filename = "query.jpg",
): Promise<MatchResponse> {
  const bytes =
    file instanceof Buffer
      ? file
      : Buffer.from(await (file as Blob).arrayBuffer());

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);

  const res = await fetch(`${SPACE_BASE}/api/v1/match`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Match failed: ${res.status} ${text}`);
  }
  return normalizeMatchResponse(JSON.parse(text) as MatchResponse);
}
