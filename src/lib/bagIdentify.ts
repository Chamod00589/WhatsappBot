const SPACE_BASE =
  process.env.BAG_IDENTIFY_BASE_URL ??
  "https://chamod482-openaiclip.hf.space";

export type BagMatch = {
  rank: number;
  product: string;
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
  return JSON.parse(text) as MatchResponse;
}
