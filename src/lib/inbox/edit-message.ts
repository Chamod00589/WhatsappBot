import type { SupabaseClient } from '@supabase/supabase-js'
import { DELETED_MESSAGE_PREVIEW } from '@/lib/inbox/soft-delete-messages'

/** Meta WhatsApp client edit window — we mirror it for agent edits. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000

/** Content types whose `content_text` (body or caption) can be edited. */
const EDITABLE_CONTENT_TYPES = new Set([
  'text',
  'image',
  'video',
  'document',
])

export function isMessageEditable(msg: {
  deleted_at?: string | null
  sender_type: string
  content_type: string
  created_at: string
  id?: string
}): boolean {
  if (msg.deleted_at) return false
  if (msg.id?.startsWith('temp-')) return false
  if (msg.sender_type !== 'agent' && msg.sender_type !== 'bot') return false
  if (!EDITABLE_CONTENT_TYPES.has(msg.content_type)) return false
  const age = Date.now() - new Date(msg.created_at).getTime()
  if (Number.isNaN(age) || age > MESSAGE_EDIT_WINDOW_MS) return false
  return true
}

export interface EditMessageResult {
  messageId: string
  conversationId: string
  contentText: string
  editedAt: string
}

/**
 * Edit an outbound message body/caption in the shared inbox.
 * Meta Cloud API cannot update the customer's WhatsApp copy.
 */
export async function editMessageForAccount(
  db: SupabaseClient,
  args: {
    conversationId: string
    accountId: string
    messageId: string
    contentText: string
    editedBy: string | null
  },
): Promise<EditMessageResult> {
  const contentText = args.contentText.trim()
  if (!contentText) {
    throw new Error('Message text is required')
  }
  if (contentText.length > 4096) {
    throw new Error('Message text is too long (max 4096)')
  }

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (convErr) throw convErr
  if (!conv) throw new Error('Conversation not found')

  const { data: row, error: fetchErr } = await db
    .from('messages')
    .select(
      'id, sender_type, content_type, content_text, created_at, deleted_at',
    )
    .eq('id', args.messageId)
    .eq('conversation_id', args.conversationId)
    .maybeSingle()

  if (fetchErr) throw fetchErr
  if (!row) throw new Error('Message not found')
  if (row.deleted_at) throw new Error('Cannot edit a deleted message')
  if (!isMessageEditable(row)) {
    throw new Error(
      'Only outbound text/media captions can be edited within 15 minutes',
    )
  }

  const editedAt = new Date().toISOString()
  const { error: updateErr } = await db
    .from('messages')
    .update({
      content_text: contentText,
      edited_at: editedAt,
      edited_by: args.editedBy,
    })
    .eq('id', args.messageId)
    .eq('conversation_id', args.conversationId)
    .is('deleted_at', null)

  if (updateErr) throw updateErr

  await refreshPreviewIfLatest(db, args.conversationId, args.messageId, contentText)

  return {
    messageId: args.messageId,
    conversationId: args.conversationId,
    contentText,
    editedAt,
  }
}

/**
 * Apply an inbound coexistence edit webhook to a stored message.
 */
export async function applyInboundMessageEdit(
  db: SupabaseClient,
  args: {
    conversationId: string
    metaMessageId: string
    contentText: string | null
  },
): Promise<string | null> {
  const { conversationId, metaMessageId } = args
  if (!metaMessageId) return null

  const contentText = args.contentText?.trim() ?? ''
  if (!contentText) return null

  const { data: row, error: fetchErr } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', metaMessageId)
    .is('deleted_at', null)
    .maybeSingle()

  if (fetchErr) {
    console.error('[edit-message] inbound lookup failed:', fetchErr.message)
    return null
  }
  if (!row?.id) return null

  const editedAt = new Date().toISOString()
  const { error: updateErr } = await db
    .from('messages')
    .update({
      content_text: contentText,
      edited_at: editedAt,
      edited_by: null,
    })
    .eq('id', row.id)
    .is('deleted_at', null)

  if (updateErr) {
    console.error('[edit-message] inbound update failed:', updateErr.message)
    return null
  }

  await refreshPreviewIfLatest(db, conversationId, row.id as string, contentText)
  return row.id as string
}

async function refreshPreviewIfLatest(
  db: SupabaseClient,
  conversationId: string,
  messageId: string,
  contentText: string,
): Promise<void> {
  const { data: latest, error } = await db
    .from('messages')
    .select('id, content_text, content_type, deleted_at, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !latest || latest.id !== messageId) return

  const lastText = latest.deleted_at
    ? DELETED_MESSAGE_PREVIEW
    : contentText.trim() || `[${latest.content_type as string}]`

  const { error: convErr } = await db
    .from('conversations')
    .update({
      last_message_text: lastText,
      last_message_at: latest.created_at as string,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  if (convErr) {
    console.error('[edit-message] conversation update failed:', convErr.message)
  }
}
