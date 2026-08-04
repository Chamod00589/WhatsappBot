import type { SupabaseClient } from '@supabase/supabase-js'
import { resetSalesAgentSession } from './gates'
import { TEST_MARKER } from './types'

/**
 * Clear Sales Agent bag/quote memory and plant a *** cutoff so prior
 * chat turns are ignored — same effect as a customer sending ***, but
 * reliable from the inbox (Meta sometimes stores bare *** as unsupported).
 */
export async function clearAgentHistoryForConversation(args: {
  db: SupabaseClient
  conversationId: string
  accountId: string
}): Promise<{ messageId: string }> {
  const { db, conversationId, accountId } = args

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (convErr) throw convErr
  if (!conv) throw new Error('Conversation not found')

  await resetSalesAgentSession(db, conversationId)

  const { data: msg, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: `${TEST_MARKER} — agent history cleared`,
      ai_context_summary: `${TEST_MARKER} agent history cleared (manual inbox reset)`,
      status: 'sent',
    })
    .select('id')
    .single()

  if (msgErr || !msg) {
    throw new Error(msgErr?.message || 'Failed to insert reset marker')
  }

  await db
    .from('conversations')
    .update({
      last_message_text: 'Agent history cleared',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  return { messageId: msg.id as string }
}
