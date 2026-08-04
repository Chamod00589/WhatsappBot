"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction, MessageReferral } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  Sparkles,
  ExternalLink,
  Ban,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { InteractivePreview } from "@/components/interactive/interactive-preview";
import { useTranslations } from "next-intl";

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: {
    authorLabel: string;
    preview: string;
    mediaUrl?: string | null;
    mediaType?: Message["content_type"] | null;
  } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label, t }: { label: string, t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{t("unavailable", { label })}</span>
    </div>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadImage = useCallback(async () => {
    if (!url) return;
    setError(false);
    setLoading(true);

    const revokeIfBlob = (u: string | null) => {
      if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
    };

    // Auth proxy + some public storage URLs load more reliably as blobs
    // (avoids opaque <img> failures on chat-media public URLs).
    const shouldFetchBlob =
      url.startsWith("/api/whatsapp/media/") ||
      /\/storage\/v1\/object\/public\/chat-media\//i.test(url);

    if (shouldFetchBlob) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load media (${res.status})`);
        const blob = await res.blob();
        if (!blob.size) throw new Error("Empty media blob");
        const blobUrl = URL.createObjectURL(blob);
        setSrc((prev) => {
          revokeIfBlob(prev);
          return blobUrl;
        });
      } catch {
        // Fall back to direct URL (e.g. CORS on public storage)
        setSrc(url);
      } finally {
        setLoading(false);
      }
      return;
    }

    setSrc(url);
    setLoading(false);
  }, [url]);

  useEffect(() => {
    void loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <img
      src={src ?? ""}
      alt={alt}
      className="max-h-64 max-w-60 rounded-lg object-cover"
      onError={() => setError(true)}
    />
  );
}

function FacebookLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M24 12a12 12 0 1 0-12 12h.21v-9.34H9.63v-3h2.58V9.43c0-2.56 1.57-3.96 3.85-3.96 1.1 0 2.04.08 2.32.12v2.68H16.8c-1.24 0-1.49.59-1.49 1.46v1.9h2.98l-.39 3.01h-2.59v8.89A12 12 0 0 0 24 12Z" />
    </svg>
  );
}

function referralMediaUrl(referral: MessageReferral): string | null {
  if (referral.media_type === "video") {
    return referral.thumbnail_url || referral.image_url || null;
  }
  return referral.image_url || referral.thumbnail_url || null;
}

function referralHostname(sourceUrl?: string): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * CTWA / FB ads context card — mirrors the ad preview WhatsApp shows
 * above the customer's first message after an ad click.
 */
function AdReferralCard({
  referral,
  t,
}: {
  referral: MessageReferral;
  t: ReturnType<typeof useTranslations>;
}) {
  const [imgError, setImgError] = useState(false);
  const mediaUrl = referralMediaUrl(referral);
  const host = referralHostname(referral.source_url);
  const hasText = Boolean(referral.headline || referral.body);

  if (!mediaUrl && !hasText && !referral.source_url) return null;

  const card = (
    <div className="overflow-hidden rounded-lg bg-background/60">
      {mediaUrl && !imgError && (
        <div className="relative aspect-square w-full max-w-60 bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mediaUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
          <span className="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#1877F2] text-white shadow-sm">
            <FacebookLogo className="h-3.5 w-3.5" />
          </span>
        </div>
      )}
      {(hasText || host) && (
        <div className="space-y-0.5 px-2.5 py-2">
          {referral.headline && (
            <p className="line-clamp-2 text-xs font-semibold leading-snug">
              {referral.headline}
            </p>
          )}
          {referral.body && (
            <p className="line-clamp-4 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
              {referral.body}
            </p>
          )}
          {host && (
            <p className="pt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
              {host}
            </p>
          )}
        </div>
      )}
      {!mediaUrl && !hasText && referral.source_url && (
        <div className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-muted-foreground">
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span>{t("adReferralOpen")}</span>
        </div>
      )}
    </div>
  );

  if (referral.source_url) {
    return (
      <a
        href={referral.source_url}
        target="_blank"
        rel="noopener noreferrer"
        className="mb-2 block max-w-60 overflow-hidden rounded-lg ring-1 ring-border/60 transition-opacity hover:opacity-90"
        title={t("adReferral")}
        onClick={(e) => e.stopPropagation()}
      >
        {card}
      </a>
    );
  }

  return <div className="mb-2 max-w-60">{card}</div>;
}

function MessageContent({ message, t }: { message: Message, t: ReturnType<typeof useTranslations> }) {
  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div>
          {message.media_url ? (
            <MediaImage url={message.media_url} alt="Shared image" />
          ) : (
            <MediaUnavailable label={t("photo")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div>
          {message.media_url ? (
            <video
              src={message.media_url}
              controls
              className="max-h-64 max-w-60 rounded-lg"
            />
          ) : (
            <MediaUnavailable label={t("video")} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      return (
        <div>
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label={t("audio")} t={t} />
          )}
        </div>
      );

    case "document":
      if (!message.media_url) {
        return <MediaUnavailable label={message.content_text || t("document")} t={t} />;
      }
      return (
        <a
          href={message.media_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {message.content_text || t("document")}
          </span>
        </a>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            {t("template")}
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || t("locationShared")}</span>
        </div>
      );

    case "interactive": {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      if (message.interactive_payload) {
        return <InteractivePreview payload={message.interactive_payload} />;
      }
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              {t("buttonReply")}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.content_text || t("interactiveReply")}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("interactiveReply")}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || t("unsupported")}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const t = useTranslations("Inbox.bubble");

  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");
  const isDeleted = !!message.deleted_at;
  const referral =
    !isDeleted &&
    message.referral &&
    Object.keys(message.referral).length > 0
      ? message.referral
      : null;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
          isDeleted && "opacity-80",
        )}
      >
        {isDeleted ? (
          <div
            className={cn(
              "flex items-center gap-1.5 text-sm italic",
              isAgent
                ? "text-primary-foreground/80"
                : "text-muted-foreground",
            )}
          >
            <Ban className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span>{t("messageDeleted")}</span>
          </div>
        ) : (
          <>
            {reply && (
              <ReplyQuote
                authorLabel={reply.authorLabel}
                preview={reply.preview}
                mediaUrl={reply.mediaUrl}
                mediaType={reply.mediaType}
                onPrimary={isAgent}
              />
            )}
            {referral && <AdReferralCard referral={referral} t={t} />}
            <MessageContent message={message} t={t} />
          </>
        )}
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          {/* AI badge — only on replies the auto-reply bot generated
              (always outbound, so it sits on the primary fill). Lets
              agents tell an AI reply from their own / a Flow's at a
              glance. */}
          {!isDeleted && message.ai_generated && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-primary-foreground/20 px-1.5 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-primary-foreground"
              title={t("aiBadgeTitle")}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t("aiBadge")}
            </span>
          )}
          {!isDeleted && message.edited_at && (
            <span
              className={cn(
                "text-[10px] italic",
                isAgent
                  ? "text-primary-foreground/70"
                  : "text-muted-foreground",
              )}
              title={t("editedTitle")}
            >
              {t("edited")}
            </span>
          )}
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {!isDeleted && isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {!isDeleted && reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
