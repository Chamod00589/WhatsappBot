# Handbag Identifier API (Next.js + Postman)

Identify product name + color from an image via the Hugging Face Space.

| | |
|---|---|
| **Space** | https://huggingface.co/spaces/chamod482/OpenaiClip |
| **Base URL** | `https://chamod482-openaiclip.hf.space` |
| **Best endpoint** | `POST /api/v1/match` (one request, no SSE) |
| **Auth** | Not required while Space is **public**. If private: `Authorization: Bearer <HF_TOKEN>`. |

> **Note on container logs:** `HTTPException: 404` on `/gradio_api/call/match/{event_id}` usually means a **stale Gradio event_id** (Space restarted, or Postman reconnected to SSE). The app itself is still running (`Catalog ready` + `Running on local URL`). Prefer **`/api/v1/match`** below to avoid that.

---

## Response shape

```ts
export type BagMatch = {
  rank: number;
  product: string;
  color: string;
  confidence: number; // 0–100
  image_path: string; // e.g. "products-images/Bunny Bag/Pink.webp"
};

export type MatchResponse = {
  matches: BagMatch[];
  error?: string;
};
```

Example:

```json
{
  "matches": [
    {
      "rank": 1,
      "product": "Bunny Bag",
      "color": "Pink",
      "confidence": 100.0,
      "image_path": "products-images/Bunny Bag/Pink.webp"
    }
  ]
}
```

---

## Postman (recommended — 1 request)

1. **Method:** `POST`  
2. **URL:** `https://chamod482-openaiclip.hf.space/api/v1/match`  
3. **Body → form-data**

| KEY | Type | VALUE |
|-----|------|--------|
| `file` | **File** | your image |

4. Send → get JSON matches directly.

Health check: `GET https://chamod482-openaiclip.hf.space/api/v1/health`

---

## Next.js Route Handler (App Router)

### `lib/bagIdentify.ts`

```ts
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
  form.append("file", new Blob([bytes]), filename);

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
```

### `app/api/identify/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { identifyBag } from "@/lib/bagIdentify";

export const runtime = "nodejs";
export const maxDuration = 120; // ZeroGPU cold start can be slow

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("image");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing form field `image` (file)" },
        { status: 400 },
      );
    }

    const result = await identifyBag(file, file.name || "query.jpg");
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Identify failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

### Client form

```tsx
"use client";

export function IdentifyForm() {
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/identify", { method: "POST", body: fd });
    const data = await res.json();
    console.log(data.matches);
  }

  return (
    <form onSubmit={onSubmit}>
      <input type="file" name="image" accept="image/*" required />
      <button type="submit">Identify</button>
    </form>
  );
}
```

### Env

```env
BAG_IDENTIFY_BASE_URL=https://chamod482-openaiclip.hf.space
# HF_TOKEN=hf_xxx   # only if Space is private
```

---

## Legacy Gradio SSE API (avoid if possible)

Still available: `/gradio_api/upload` → `/gradio_api/call/match` → `GET .../call/match/{event_id}`.

This is what caused the container `404 Not Found` / Postman “Connection closed” issues. Use **`/api/v1/match`** instead.

| API name | Purpose |
|----------|---------|
| `POST /api/v1/match` | **Preferred** — multipart `file` → JSON |
| `GET /api/v1/health` | Health / catalog size |
| `/match` (Gradio) | JSON via SSE (legacy) |
| `/identify` (Gradio) | Markdown + gallery |

---

## Production notes

1. First request after sleep can take 30–90s (ZeroGPU).
2. Call Space from your **Next.js server**, not the browser (keeps options open if Space becomes private).
3. WhatsApp: media → `POST /api/identify` on Next → reply with `matches[0].product` + `color`.
