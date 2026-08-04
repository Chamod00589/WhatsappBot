"use client";

import { X, Image as ImageIcon, Film, FileText, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";
import { useTranslations } from "next-intl";

interface ReplyQuoteProps {
  /** Sender label of the quoted message: "You" for our own messages,
   *  contact name for customer-sent messages. Caller resolves this — the
   *  quote component doesn't see the parent Message. */
  authorLabel: string;
  /** Compact text preview. Falls back to a placeholder for media types. */
  preview: string;
  /** Thumbnail for quoted image/video (or document preview). */
  mediaUrl?: string | null;
  mediaType?: Message["content_type"] | null;
  /** Present → renders the composer-chip variant with an X button. Absent →
   *  renders the embedded-in-bubble variant. */
  onDismiss?: () => void;
  /** True when embedded inside an outbound (primary-filled) bubble, so the
   *  quote must read against the primary surface rather than the neutral
   *  foreground — otherwise it goes low-contrast in light mode. */
  onPrimary?: boolean;
}

export function ReplyQuote({
  authorLabel,
  preview,
  mediaUrl,
  mediaType,
  onDismiss,
  onPrimary = false,
}: ReplyQuoteProps) {
  const t = useTranslations("Inbox.replyQuote");
  const isChip = !!onDismiss;
  const showImageThumb =
    !!mediaUrl && (mediaType === "image" || mediaType === "video" || !mediaType);

  return (
    <div
      className={cn(
        "flex items-start gap-2 border-l-2 px-2 py-1",
        onPrimary ? "border-primary-foreground/50" : "border-primary",
        isChip
          ? "rounded-md bg-muted/80"
          : onPrimary
            ? "mb-1.5 rounded-md bg-primary-foreground/15"
            : "mb-1.5 rounded-md bg-background/20",
      )}
    >
      {showImageThumb ? (
        <a
          href={mediaUrl!}
          target="_blank"
          rel="noopener noreferrer"
          className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-muted"
          onClick={(e) => e.stopPropagation()}
          title={t("photo")}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl!}
            alt=""
            className="h-full w-full object-cover"
          />
          {mediaType === "video" && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/35">
              <Film className="h-4 w-4 text-white" />
            </span>
          )}
        </a>
      ) : mediaType === "audio" ? (
        <span
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-md",
            onPrimary ? "bg-primary-foreground/20" : "bg-muted",
          )}
        >
          <Mic className="h-4 w-4 opacity-70" />
        </span>
      ) : mediaType === "document" ? (
        <span
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-md",
            onPrimary ? "bg-primary-foreground/20" : "bg-muted",
          )}
        >
          <FileText className="h-4 w-4 opacity-70" />
        </span>
      ) : mediaType === "image" && !mediaUrl ? (
        <span
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-md",
            onPrimary ? "bg-primary-foreground/20" : "bg-muted",
          )}
        >
          <ImageIcon className="h-4 w-4 opacity-70" />
        </span>
      ) : null}

      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "truncate text-[11px] font-medium",
            onPrimary ? "text-primary-foreground" : "text-primary",
          )}
        >
          {authorLabel}
        </div>
        <div
          className={cn(
            "line-clamp-2 break-words text-xs",
            onPrimary ? "text-primary-foreground/80" : "text-foreground/80",
          )}
        >
          {preview}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("cancelReply")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Build the one-line preview text shown inside a reply quote. */
export function buildReplyPreview(
  message: Message,
  t: ReturnType<typeof useTranslations>,
): string {
  if (message.deleted_at) return t("messageDeleted");
  // Prefer caption/text when present; for pure media fall back to a label.
  if (message.content_text?.trim()) return message.content_text;
  switch (message.content_type) {
    case "image":
      return t("photo");
    case "video":
      return t("video");
    case "audio":
      return t("audio");
    case "document":
      return t("document");
    case "location":
      return t("location");
    case "template":
      return t("template");
    default:
      return t("message");
  }
}

/** Quote fields derived from a parent message (bubble + composer chip). */
export function buildReplyQuoteFields(
  message: Message,
  t: ReturnType<typeof useTranslations>,
): {
  preview: string;
  mediaUrl: string | null;
  mediaType: Message["content_type"];
} {
  if (message.deleted_at) {
    return {
      preview: t("messageDeleted"),
      mediaUrl: null,
      mediaType: message.content_type,
    };
  }
  return {
    preview: buildReplyPreview(message, t),
    mediaUrl: message.media_url ?? null,
    mediaType: message.content_type,
  };
}
