"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Download,
  Loader2,
  MessageSquare,
  Package,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  InteractiveBuilder,
  blankButtonsPayload,
} from "@/components/interactive/interactive-builder";
import {
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from "@/lib/whatsapp/interactive";
import type { QuickReply, QuickReplyKind } from "@/types";

interface DraftState {
  id?: string;
  title: string;
  kind: QuickReplyKind;
  content_text: string;
  interactive_payload: InteractiveMessagePayload;
  product_id?: string | null;
  catalog_message_id?: string | null;
  badge_color?: string | null;
}

function emptyDraft(): DraftState {
  return {
    title: "",
    kind: "text",
    content_text: "",
    interactive_payload: blankButtonsPayload(),
  };
}

function previewFor(qr: QuickReply): string {
  if (qr.kind === "product" || qr.kind === "catalog") {
    const bits = [
      qr.product_id ? "Product" : "Custom",
      qr.catalog_message_id || qr.product_id || "catalog",
    ]
    return bits.join(" · ")
  }
  if (qr.kind === "interactive" && qr.interactive_payload) {
    return interactivePayloadPreviewText(qr.interactive_payload);
  }
  return qr.content_text ?? "";
}

export function QuickRepliesManager() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/quick-replies", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((data.quick_replies as QuickReply[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => setDraft(emptyDraft());
  const openEdit = (qr: QuickReply) =>
    setDraft({
      id: qr.id,
      title: qr.title,
      kind: qr.kind,
      content_text: qr.content_text ?? "",
      interactive_payload:
        qr.interactive_payload ?? blankButtonsPayload(),
      product_id: qr.product_id,
      catalog_message_id: qr.catalog_message_id,
      badge_color: qr.badge_color,
    });

  const importProducts = useCallback(async () => {
    setImporting(true);
    try {
      const res = await fetch("/api/quick-replies/import-products?prune=1", {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't import products.");
        return;
      }
      const parts = [
        `${data.messages ?? data.products ?? 0} messages`,
        `${data.created ?? 0} added`,
        `${data.updated ?? 0} updated`,
      ];
      if (typeof data.custom === "number") parts.push(`${data.custom} custom`);
      if (typeof data.jpegReady === "number") {
        parts.push(`${data.jpegReady} JPEG-ready`);
      }
      if (data.pruned) parts.push(`${data.pruned} removed`);
      toast.success(`Catalog synced — ${parts.join(", ")}.`);
      await load();
    } catch {
      toast.error("Couldn't import products.");
    } finally {
      setImporting(false);
    }
  }, [load]);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) {
      toast.error("Give the quick reply a name.");
      return;
    }

    // Catalog stubs are admin-managed — only the display title is editable.
    if (draft.kind === "product" || draft.kind === "catalog") {
      if (!draft.id) {
        toast.error("Import from ladiesbags.lk catalog instead of creating manually.");
        return;
      }
      setSaving(true);
      try {
        const res = await fetch(`/api/quick-replies/${draft.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: draft.title }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error ?? "Couldn't save the quick reply.");
          return;
        }
        toast.success("Quick reply updated.");
        setDraft(null);
        await load();
      } catch {
        toast.error("Couldn't save the quick reply.");
      } finally {
        setSaving(false);
      }
      return;
    }

    const payload =
      draft.kind === "interactive"
        ? { title: draft.title, kind: "interactive", interactive_payload: draft.interactive_payload }
        : { title: draft.title, kind: "text", content_text: draft.content_text };

    setSaving(true);
    try {
      const res = await fetch(
        draft.id ? `/api/quick-replies/${draft.id}` : "/api/quick-replies",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save the quick reply.");
        return;
      }
      toast.success(draft.id ? "Quick reply updated." : "Quick reply created.");
      setDraft(null);
      await load();
    } catch {
      toast.error("Couldn't save the quick reply.");
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this quick reply?")) return;
      const res = await fetch(`/api/quick-replies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Couldn't delete the quick reply.");
        return;
      }
      await load();
    },
    [load],
  );

  return (
    <div>
      <SettingsPanelHead
        title="Quick replies"
        description="Reusable snippets — plain text, interactive, or catalog messages from ladiesbags.lk admin (products + custom, badge colors). Stubs only — images/text resolved live on send."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={importProducts}
              disabled={importing}
            >
              {importing ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1 h-4 w-4" />
              )}
              Import / update all
            </Button>
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              New quick reply
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No quick replies yet. Import from ladiesbags.lk admin (products + custom) or create a text snippet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((qr) => (
            <li
              key={qr.id}
              className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
            >
              {qr.kind === "interactive" ? (
                <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              ) : qr.kind === "product" || qr.kind === "catalog" ? (
                qr.badge_color ? (
                  <span
                    className="mt-1 h-4 w-4 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: qr.badge_color }}
                    title={qr.badge_color}
                  />
                ) : (
                  <Package className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                )
              ) : (
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{qr.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {previewFor(qr)}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(qr)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(qr.id)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit quick reply" : "New quick reply"}</DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Name</label>
                <Input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="e.g. Business hours"
                  className="bg-muted text-foreground"
                />
              </div>
              {draft.kind === "product" || draft.kind === "catalog" ? (
                <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Catalog quick reply</p>
                  <p className="mt-1">
                    Only the name is stored here. Caption text and images load from
                    ladiesbags.lk admin on send (prefer pre-converted JPEGs).
                  </p>
                  {draft.badge_color && (
                    <p className="mt-2 flex items-center gap-2 text-xs">
                      <span
                        className="inline-block h-3 w-3 rounded-full border"
                        style={{ backgroundColor: draft.badge_color }}
                      />
                      {draft.badge_color}
                    </p>
                  )}
                  {draft.catalog_message_id && (
                    <p className="mt-1 font-mono text-xs">id: {draft.catalog_message_id}</p>
                  )}
                  {draft.product_id && (
                    <p className="mt-1 font-mono text-xs">product_id: {draft.product_id}</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <KindTab
                      active={draft.kind === "text"}
                      label="Text"
                      onClick={() => setDraft({ ...draft, kind: "text" })}
                    />
                    <KindTab
                      active={draft.kind === "interactive"}
                      label="Interactive"
                      onClick={() => setDraft({ ...draft, kind: "interactive" })}
                    />
                  </div>
                  {draft.kind === "text" ? (
                    <Textarea
                      value={draft.content_text}
                      onChange={(e) => setDraft({ ...draft, content_text: e.target.value })}
                      placeholder="The message text to insert"
                      className="min-h-28 bg-muted text-foreground"
                    />
                  ) : (
                    <InteractiveBuilder
                      value={draft.interactive_payload}
                      onChange={(p) => setDraft({ ...draft, interactive_payload: p })}
                    />
                  )}
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KindTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "flex-1 rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary"
          : "flex-1 rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}
