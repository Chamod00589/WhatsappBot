"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Tag as TagIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import { cn } from "@/lib/utils";
import type { Tag } from "@/types";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface ContactTagChipsProps {
  contactId: string | null | undefined;
  /** Compact dropdown for the chat header vs fuller chips in the sidebar. */
  variant?: "header" | "panel";
  className?: string;
  /** Bump to force a refetch (e.g. after opening the contact sheet). */
  refreshKey?: number;
  onChange?: () => void;
}

/**
 * Selectable tags for a contact. Header variant is a compact dropdown
 * that shows selected values on the trigger; panel variant lists chips.
 */
export function ContactTagChips({
  contactId,
  variant = "panel",
  className,
  refreshKey = 0,
  onChange,
}: ContactTagChipsProps) {
  const t = useTranslations("Inbox.sidebar");
  const { accountId } = useAuth();
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [savingTagId, setSavingTagId] = useState<string | null>(null);

  const fetchTags = useCallback(async () => {
    if (!contactId) {
      setAllTags([]);
      setAssignedIds(new Set());
      return;
    }
    const supabase = createClient();
    let allQuery = supabase
      .from("tags")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (accountId) allQuery = allQuery.eq("account_id", accountId);

    const [allRes, assignedRes] = await Promise.all([
      allQuery,
      supabase
        .from("contact_tags")
        .select("tag_id")
        .eq("contact_id", contactId),
    ]);

    if (allRes.data) setAllTags(allRes.data);
    if (assignedRes.data) {
      setAssignedIds(new Set(assignedRes.data.map((r) => r.tag_id as string)));
    } else {
      setAssignedIds(new Set());
    }
  }, [contactId, accountId]);

  useEffect(() => {
    void fetchTags();
  }, [fetchTags, refreshKey]);

  const handleToggle = useCallback(
    async (tag: Tag) => {
      if (!contactId) return;
      const selected = assignedIds.has(tag.id);
      setSavingTagId(tag.id);
      setAssignedIds((prev) => {
        const next = new Set(prev);
        if (selected) next.delete(tag.id);
        else next.add(tag.id);
        return next;
      });
      try {
        if (selected) await deleteContactTag(contactId, tag.id);
        else await addContactTag(contactId, tag.id);
        onChange?.();
      } catch (err) {
        setAssignedIds((prev) => {
          const next = new Set(prev);
          if (selected) next.add(tag.id);
          else next.delete(tag.id);
          return next;
        });
        toast.error(
          err instanceof Error ? err.message : t("tagUpdateFailed"),
        );
      } finally {
        setSavingTagId(null);
      }
    },
    [contactId, assignedIds, onChange, t],
  );

  const selectedTags = useMemo(
    () => allTags.filter((tag) => assignedIds.has(tag.id)),
    [allTags, assignedIds],
  );

  if (!contactId) return null;

  if (allTags.length === 0) {
    if (variant === "header") return null;
    return (
      <p className="px-1 text-xs text-muted-foreground">{t("noTagsDefined")}</p>
    );
  }

  if (variant === "header") {
    return (
      <Popover>
        <PopoverTrigger
          className={cn(
            "inline-flex h-7 max-w-[9.5rem] items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-muted",
            selectedTags.length > 0
              ? "text-foreground"
              : "text-muted-foreground",
            className,
          )}
          aria-label={t("tags")}
        >
          <TagIcon className="h-3 w-3 shrink-0" />
          {selectedTags.length === 0 ? (
            <span className="truncate">{t("tags")}</span>
          ) : (
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              {selectedTags.slice(0, 2).map((tag) => (
                <span
                  key={tag.id}
                  className="max-w-[4.5rem] truncate rounded-full px-1.5 py-px text-[10px] font-medium"
                  style={{
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                  }}
                >
                  {tag.name}
                </span>
              ))}
              {selectedTags.length > 2 ? (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  +{selectedTags.length - 2}
                </span>
              ) : null}
            </span>
          )}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 gap-1 p-1.5">
          <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("tags")}
          </p>
          <div className="max-h-56 overflow-y-auto">
            {allTags.map((tag) => {
              const selected = assignedIds.has(tag.id);
              const busy = savingTagId === tag.id;
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void handleToggle(tag)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                    busy && "opacity-60",
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {tag.name}
                  </span>
                  {selected ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {allTags.map((tag) => {
        const selected = assignedIds.has(tag.id);
        const busy = savingTagId === tag.id;
        return (
          <button
            key={tag.id}
            type="button"
            disabled={busy}
            onClick={() => void handleToggle(tag)}
            title={
              selected
                ? t("unassignTag", { name: tag.name })
                : t("assignTag", { name: tag.name })
            }
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-medium transition-all",
              selected
                ? "ring-2 ring-primary ring-offset-1 ring-offset-card"
                : "opacity-45 hover:opacity-90",
              busy && "opacity-60",
            )}
            style={{
              backgroundColor: `${tag.color}20`,
              color: tag.color,
            }}
          >
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}
