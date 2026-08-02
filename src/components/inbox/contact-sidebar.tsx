"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type {
  Contact,
  Deal,
  ContactNote,
  ConversationStatus,
} from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ContactTagChips } from "@/components/inbox/contact-tag-chips";
import { ConversationThreadControls } from "@/components/inbox/conversation-thread-controls";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Optional className for the outer shell (mobile sheet vs desktop column). */
  className?: string;
  /**
   * When set (mobile contact sheet), show status / assign / refresh here
   * instead of the thread header.
   */
  conversationControls?: {
    conversationId: string;
    status: ConversationStatus;
    assignedAgentId: string | null;
    onStatusChange: (
      conversationId: string,
      status: ConversationStatus,
    ) => void;
    onAssignChange: (
      conversationId: string,
      assignedAgentId: string | null,
    ) => void;
    onRefresh?: () => void;
    onDeleted?: (conversationId: string) => void;
  } | null;
  /** Bump when the sheet opens so tags refetch after header edits. */
  tagsRefreshKey?: number;
}

export function ContactSidebar({
  contact,
  className,
  conversationControls,
  tagsRefreshKey = 0,
}: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    const [dealsRes, notesRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
  }, [contact]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div
        className={cn(
          "flex h-full w-full items-center justify-center border-l border-border bg-card lg:w-70",
          className,
        )}
      >
        <p className="text-sm text-muted-foreground">
          {tThread("selectConversation")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col border-l border-border bg-card lg:w-70",
        className,
      )}
    >
      <ScrollArea className="flex-1">
        <div className="p-4">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Mobile: status / assign / refresh live here (hidden from header). */}
          {conversationControls && (
            <>
              <div className="mt-4">
                <ConversationThreadControls
                  conversationId={conversationControls.conversationId}
                  status={conversationControls.status}
                  assignedAgentId={conversationControls.assignedAgentId}
                  onStatusChange={conversationControls.onStatusChange}
                  onAssignChange={conversationControls.onAssignChange}
                  onRefresh={conversationControls.onRefresh}
                  onDeleted={conversationControls.onDeleted}
                  layout="row"
                />
              </div>
              <div className="my-4 border-t border-border" />
            </>
          )}

          <div className={cn("space-y-2", !conversationControls && "mt-4")}>
            <button
              type="button"
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          <div className="my-4 border-t border-border" />

          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <p className="mt-1 px-1 text-[10px] text-muted-foreground">
              {tSidebar("tagsHint")}
            </p>
            <div className="mt-2">
              <ContactTagChips
                contactId={contact.id}
                variant="panel"
                refreshKey={tagsRefreshKey}
              />
            </div>
          </div>

          <div className="my-4 border-t border-border" />

          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {tSidebar("noDeals")}
                </p>
              ) : (
                deals.map((deal) => (
                  <div key={deal.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="my-4 border-t border-border" />

          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={() => void handleAddNote()}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
