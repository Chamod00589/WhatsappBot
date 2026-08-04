import type { SupabaseClient } from '@supabase/supabase-js'

/** Placeholder shown in conversation list after soft-delete. */
export const DELETED_MESSAGE_PREVIEW = 'This message was deleted'

export interface SoftDeleteMessagesResult {
  deletedIds: string[]
  conversationId: string
}

/**
 * Soft-delete messages in a conversation (account-scoped).
 *
 * Sets `deleted_at` / `deleted_by`, scrubs visible content fields, and
 * refreshes `conversations.last_message_*` when the latest row was hit.
 *
 * Meta Cloud API cannot revoke messages on the customer's phone — this
 * only affects the shared inbox for all agents.
 */
export async function softDeleteMessagesForAccount(
  db: SupabaseClient,
  args: {
    conversationId: string
    accountId: string
    messageIds: string[]
    deletedBy: string | null
  },
): Promise<SoftDeleteMessagesResult> {
  const { conversationId, accountId, deletedBy } = args
  const messageIds = [...new Set(args.messageIds.filter(Boolean))]
  if (messageIds.length === 0) {
    throw new Error('No messages to delete')
  }
  if (messageIds.length > 100) {
    throw new Error('Too many messages (max 100)')
  }

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (convErr) throw convErr
  if (!conv) throw new Error('Conversation not found')

  const { data: rows, error: fetchErr } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('id', messageIds)
    .is('deleted_at', null)

  if (fetchErr) throw fetchErr
  const deletableIds = (rows ?? []).map((r: { id: string }) => r.id)
  if (deletableIds.length === 0) {
    return { deletedIds: [], conversationId }
  }

  const now = new Date().toISOString()
  const { error: updateErr } = await db
    .from('messages')
    .update({
      deleted_at: now,
      deleted_by: deletedBy,
      content_text: null,
      media_url: null,
      template_name: null,
      interactive_payload: null,
      interactive_reply_id: null,
      referral: null,
      ai_context_summary: null,
    })
    .eq('conversation_id', conversationId)
    .in('id', deletableIds)
    .is('deleted_at', null)

  if (updateErr) throw updateErr

  await refreshConversationPreview(db, conversationId)

  return { deletedIds: deletableIds, conversationId }
}

/**
 * Soft-delete by Meta wamid (inbound revoke webhook). Scoped to one
 * conversation. No-op when the message is missing or already deleted.
 */
export async function softDeleteMessageByMetaId(
  db: SupabaseClient,
  args: {
    conversationId: string
    metaMessageId: string
  },
): Promise<string | null> {
  const { conversationId, metaMessageId } = args
  if (!metaMessageId) return null

  const { data: row, error: fetchErr } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', metaMessageId)
    .is('deleted_at', null)
    .maybeSingle()

  if (fetchErr) {
    console.error('[soft-delete] lookup by meta id failed:', fetchErr.message)
    return null
  }
  if (!row?.id) return null

  const now = new Date().toISOString()
  const { error: updateErr } = await db
    .from('messages')
    .update({
      deleted_at: now,
      deleted_by: null,
      content_text: null,
      media_url: null,
      template_name: null,
      interactive_payload: null,
      interactive_reply_id: null,
      referral: null,
      ai_context_summary: null,
    })
    .eq('id', row.id)
    .is('deleted_at', null)

  if (updateErr) {
    console.error('[soft-delete] revoke update failed:', updateErr.message)
    return null
  }

  await refreshConversationPreview(db, conversationId)
  return row.id as string
}

async function refreshConversationPreview(
  db: SupabaseClient,
  conversationId: string,
): Promise<void> {
  const { data: latest, error } = await db
    .from('messages')
    .select('content_text, content_type, deleted_at, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[soft-delete] preview refresh failed:', error.message)
    return
  }

  let lastText = ''
  let lastAt = new Date().toISOString()
  if (latest) {
    lastAt = latest.created_at as string
    if (latest.deleted_at) {
      lastText = DELETED_MESSAGE_PREVIEW
    } else {
      lastText =
        (latest.content_text as string | null)?.trim() ||
        `[${latest.content_type as string}]`
    }
  }

  const { error: convErr } = await db
    .from('conversations')
    .update({
      last_message_text: lastText,
      last_message_at: lastAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  if (convErr) {
    console.error('[soft-delete] conversation update failed:', convErr.message)
  }
}
