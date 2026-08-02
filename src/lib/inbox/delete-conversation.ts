import type { SupabaseClient } from '@supabase/supabase-js'

export const CHAT_MEDIA_BUCKET = 'chat-media'

/**
 * Extract an account-scoped `chat-media` object path from a public
 * Storage URL. Returns null for Meta proxy paths and foreign URLs.
 */
export function chatMediaPathFromUrl(
  url: string | null | undefined,
  accountId: string,
): string | null {
  if (!url || typeof url !== 'string') return null
  if (url.startsWith('/api/whatsapp/media/')) return null

  const marker = '/object/public/chat-media/'
  const idx = url.indexOf(marker)
  if (idx === -1) return null

  let path = url.slice(idx + marker.length).split('?')[0] ?? ''
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep raw path
  }
  if (!path || path.includes('..')) return null

  const prefix = `account-${accountId}/`
  if (!path.startsWith(prefix)) return null
  return path
}

export interface DeleteConversationResult {
  conversationId: string
  mediaRemoved: number
  mediaFailed: number
}

/**
 * Hard-delete a conversation for an account: GC chat-media objects,
 * null deal links, then delete the conversation row (CASCADE messages
 * / reactions / notifications / sales_agent_runs). Contact is kept.
 */
export async function deleteConversationForAccount(
  db: SupabaseClient,
  args: { conversationId: string; accountId: string },
): Promise<DeleteConversationResult> {
  const { conversationId, accountId } = args

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, account_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (convErr) throw new Error(convErr.message)
  if (!conv) throw new Error('Conversation not found')

  const mediaPaths = new Set<string>()
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data: rows, error: msgErr } = await db
      .from('messages')
      .select('media_url')
      .eq('conversation_id', conversationId)
      .not('media_url', 'is', null)
      .range(from, from + pageSize - 1)

    if (msgErr) throw new Error(msgErr.message)
    if (!rows?.length) break

    for (const row of rows) {
      const path = chatMediaPathFromUrl(
        typeof row.media_url === 'string' ? row.media_url : null,
        accountId,
      )
      if (path) mediaPaths.add(path)
    }
    if (rows.length < pageSize) break
  }

  const { error: dealsErr } = await db
    .from('deals')
    .update({ conversation_id: null })
    .eq('conversation_id', conversationId)

  if (dealsErr) throw new Error(dealsErr.message)

  const { error: delErr } = await db
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('account_id', accountId)

  if (delErr) throw new Error(delErr.message)

  let mediaRemoved = 0
  let mediaFailed = 0
  const paths = Array.from(mediaPaths)
  const chunkSize = 50
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize)
    const { error: storageErr } = await db.storage
      .from(CHAT_MEDIA_BUCKET)
      .remove(chunk)
    if (storageErr) {
      console.warn(
        '[deleteConversation] chat-media GC failed:',
        storageErr.message,
        chunk.length,
      )
      mediaFailed += chunk.length
    } else {
      mediaRemoved += chunk.length
    }
  }

  return { conversationId, mediaRemoved, mediaFailed }
}
