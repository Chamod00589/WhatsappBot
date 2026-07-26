"use client";

import { useCallback, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, ScanSearch, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type BagMatch = {
  rank: number;
  product: string;
  color: string;
  confidence: number;
  image_path: string;
};

function catalogImageUrl(imagePath: string): string {
  return (
    "/" +
    imagePath
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/")
  );
}

export default function IdentifyPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState<BagMatch[] | null>(null);

  const clearSelection = useCallback(() => {
    setFile(null);
    setMatches(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [previewUrl]);

  const onFileChange = (next: File | null) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setMatches(null);
    if (!next) {
      setFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!next.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    setFile(next);
    setPreviewUrl(URL.createObjectURL(next));
  };

  const onIdentify = async () => {
    if (!file) {
      toast.error("Select an image first");
      return;
    }

    setLoading(true);
    setMatches(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch("/api/identify", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Identify failed");
      }
      if (data.error) {
        throw new Error(data.error);
      }
      setMatches(Array.isArray(data.matches) ? data.matches : []);
      if (!data.matches?.length) {
        toast.message("No matches found");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Identify failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <ScanSearch className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Identify Bag
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Upload a product photo to find matching bags and colors from the
        catalog.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Query image</CardTitle>
            <CardDescription>
              First request after idle can take up to a minute while the model
              wakes up.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />

            {previewUrl ? (
              <div className="relative overflow-hidden rounded-lg ring-1 ring-foreground/10">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={previewUrl}
                  alt="Selected query"
                  className="max-h-80 w-full object-contain bg-muted/40"
                />
                <button
                  type="button"
                  onClick={clearSelection}
                  className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md bg-background/90 text-muted-foreground ring-1 ring-border hover:text-foreground"
                  aria-label="Clear image"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-16 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <Upload className="h-8 w-8" />
                <span>Click to select an image</span>
              </button>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => inputRef.current?.click()}
                disabled={loading}
              >
                {file ? "Change image" : "Select image"}
              </Button>
              <Button
                type="button"
                onClick={onIdentify}
                disabled={!file || loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Matching…
                  </>
                ) : (
                  "Find matches"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Matches</CardTitle>
            <CardDescription>
              Ranked by confidence against the product catalog.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                Identifying bag…
              </div>
            )}

            {!loading && matches === null && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                Matching catalog images will appear here.
              </p>
            )}

            {!loading && matches && matches.length === 0 && (
              <p className="py-16 text-center text-sm text-muted-foreground">
                No matches returned.
              </p>
            )}

            {!loading && matches && matches.length > 0 && (
              <ul className="grid gap-3 sm:grid-cols-2">
                {matches.map((match) => (
                  <li
                    key={`${match.rank}-${match.product}-${match.color}`}
                    className="overflow-hidden rounded-lg ring-1 ring-foreground/10"
                  >
                    <div className="relative aspect-square bg-muted/40">
                      <Image
                        src={catalogImageUrl(match.image_path)}
                        alt={`${match.product} — ${match.color}`}
                        fill
                        className="object-contain p-2"
                        sizes="(max-width: 640px) 100vw, 240px"
                        unoptimized
                      />
                    </div>
                    <div className="space-y-1 border-t border-border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium leading-snug text-foreground">
                          {match.product}
                        </p>
                        <Badge variant="secondary">#{match.rank}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {match.color}
                      </p>
                      <p className="text-xs font-medium text-primary">
                        {match.confidence.toFixed(1)}% match
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
