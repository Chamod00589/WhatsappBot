"use client";

import { useEffect, useState } from "react";
import { Loader2, MessageSquare, Package, Zap } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QuickReply } from "@/types";
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive";

interface QuickReplyPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (qr: QuickReply) => void;
}

/**
 * Lists the account's saved quick replies for insertion into the
 * composer. Catalog stubs (products + custom from ladiesbags admin)
 * show badge colors and trigger a live catalog send.
 */
export function QuickReplyPicker({
  open,
  onOpenChange,
  onPick,
}: QuickReplyPickerProps) {
  const t = useTranslations("Inbox.composer");
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch("/api/quick-replies", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!cancelled && res.ok) {
          setItems((data.quick_replies as QuickReply[]) ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("quickReplies")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("quickRepliesEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((qr) => {
                const isCatalog = qr.kind === "catalog" || qr.kind === "product";
                return (
                  <li key={qr.id}>
                    <button
                      type="button"
                      onClick={() => onPick(qr)}
                      className="flex w-full items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-left hover:border-primary/50 hover:bg-muted"
                    >
                      {qr.kind === "interactive" ? (
                        <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      ) : isCatalog && qr.badge_color ? (
                        <span
                          className="mt-1 h-4 w-4 shrink-0 rounded-full border border-border"
                          style={{ backgroundColor: qr.badge_color }}
                        />
                      ) : isCatalog ? (
                        <Package className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      ) : (
                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {qr.title}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {isCatalog
                            ? qr.product_id
                              ? "Product details + photos"
                              : "Custom quick message"
                            : qr.kind === "interactive" && qr.interactive_payload
                              ? interactivePayloadPreviewText(qr.interactive_payload)
                              : qr.content_text}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
