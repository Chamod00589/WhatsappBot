import { NextRequest, NextResponse } from "next/server";
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { identifyBag } from "@/lib/bagIdentify";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/identify  (agent+)
 *
 * Accepts multipart form field `image`, forwards to the Space
 * `POST /api/v1/match` endpoint, and returns `{ matches: BagMatch[] }`.
 */
export async function POST(req: NextRequest) {
  try {
    await requireRole("agent");

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
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    const message = err instanceof Error ? err.message : "Identify failed";
    console.error("[api/identify]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
