"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Loader2,
  RefreshCw,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { ConversationStatus, Profile } from "@/types";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STATUS_OPTIONS: {
  label: string;
  value: ConversationStatus;
  color: string;
}[] = [
  { label: "Open", value: "open", color: "text-primary" },
  { label: "Pending", value: "pending", color: "text-amber-400" },
  { label: "Closed", value: "closed", color: "text-muted-foreground" },
];

export interface ConversationThreadControlsProps {
  conversationId: string;
  status: ConversationStatus;
  assignedAgentId: string | null;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  onRefresh?: () => void;
  /** Called after the chat (messages + media) was hard-deleted. */
  onDeleted?: (conversationId: string) => void;
  /** `row` stacks controls for the contact panel; `inline` for the header. */
  layout?: "inline" | "row";
  className?: string;
}

/**
 * Status / assign / refresh / delete controls shared by the thread header
 * (desktop) and the contact panel (mobile sheet).
 */
export function ConversationThreadControls({
  conversationId,
  status,
  assignedAgentId,
  onStatusChange,
  onAssignChange,
  onRefresh,
  onDeleted,
  layout = "inline",
  className,
}: ConversationThreadControlsProps) {
  const t = useTranslations("Inbox.messageThread");
  const { user } = useAuth();
  const canDelete = useCan("send-messages");
  const { getPresence, getRow, now } = usePresence();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("profiles")
      .select("*")
      .order("full_name")
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch profiles:", error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleStatusChange = useCallback(
    async (next: ConversationStatus) => {
      const supabase = createClient();
      await supabase
        .from("conversations")
        .update({ status: next })
        .eq("id", conversationId);
      onStatusChange(conversationId, next);
    },
    [conversationId, onStatusChange],
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ assigned_agent_id: agentId })
        .eq("id", conversationId);
      if (error) {
        console.error("Failed to update assignment:", error);
        toast.error("Failed to update assignment");
        return;
      }
      onAssignChange(conversationId, agentId);
    },
    [conversationId, onAssignChange],
  );

  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);

  const handleDeleteChat = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error || t("toastChatDeleteFailed"));
      }
      setDeleteOpen(false);
      toast.success(t("toastChatDeleted"));
      onDeleted?.(conversationId);
    } catch (err) {
      console.error("Failed to delete conversation:", err);
      toast.error(
        err instanceof Error ? err.message : t("toastChatDeleteFailed"),
      );
    } finally {
      setDeleting(false);
    }
  }, [conversationId, deleting, onDeleted, t]);

  const currentStatus = STATUS_OPTIONS.find((s) => s.value === status);
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t("assigned"))
    : t("assign");

  const isRow = layout === "row";

  return (
    <div
      className={cn(
        isRow ? "flex flex-col gap-2" : "flex items-center gap-2",
        className,
      )}
    >
      {onRefresh && (
        <button
          type="button"
          onClick={handleRefreshClick}
          disabled={isRefreshing}
          aria-label={t("refreshConversation")}
          title={t("refresh")}
          className={cn(
            "inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60",
            isRow ? "h-9 w-full gap-2 px-3 text-xs" : "h-7 w-7",
          )}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
          />
          {isRow ? <span>{t("refresh")}</span> : null}
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "inline-flex items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
            isRow ? "h-9 w-full" : "h-7",
            currentStatus?.color ?? "text-muted-foreground",
          )}
        >
          {currentStatus ? t(`status${currentStatus.label}`) : t("status")}
          <ChevronDown className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          {STATUS_OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => void handleStatusChange(opt.value)}
              className={cn("text-sm", opt.color)}
            >
              {t(`status${opt.label}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "inline-flex items-center justify-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
            isRow ? "h-9 w-full" : "h-7",
            assignedAgentId ? "text-primary" : "text-muted-foreground",
          )}
        >
          <UserPlus className="h-3 w-3" />
          <span className={cn(!isRow && "hidden sm:inline")}>{assignLabel}</span>
          <ChevronDown className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          {profiles.length === 0 ? (
            <DropdownMenuItem disabled className="text-sm text-muted-foreground">
              {t("noTeammates")}
            </DropdownMenuItem>
          ) : (
            profiles.map((p) => {
              const isSelected = p.user_id === assignedAgentId;
              const presence = getPresence(p.user_id);
              return (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => void handleAssignChange(p.user_id)}
                  className={cn(
                    "text-sm",
                    isSelected ? "text-primary" : "text-popover-foreground",
                  )}
                >
                  <PresenceDot
                    status={presence}
                    label={presenceLabel(
                      presence,
                      getRow(p.user_id)?.last_seen_at ?? null,
                      now,
                    )}
                    className="mr-2"
                  />
                  <span className="flex-1">
                    {p.full_name}
                    {p.user_id === user?.id ? t("me") : ""}
                  </span>
                  {isSelected && <Check className="ml-2 h-3 w-3" />}
                </DropdownMenuItem>
              );
            })
          )}
          {assignedAgentId && (
            <>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={() => void handleAssignChange(null)}
                className="text-sm text-muted-foreground"
              >
                {t("unassign")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <GatedButton
        type="button"
        variant="ghost"
        size="sm"
        canAct={canDelete}
        gateReason="delete chats"
        onClick={() => setDeleteOpen(true)}
        title={t("deleteChat")}
        className={cn(
          "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
          isRow ? "h-9 w-full justify-center gap-2 px-3 text-xs" : "h-7 w-7 px-0",
        )}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {isRow ? <span>{t("deleteChat")}</span> : null}
      </GatedButton>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteChatTitle")}</DialogTitle>
            <DialogDescription>{t("deleteChatDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => setDeleteOpen(false)}
            >
              {t("deleteChatCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDeleteChat()}
            >
              {deleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("deleteChatConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
