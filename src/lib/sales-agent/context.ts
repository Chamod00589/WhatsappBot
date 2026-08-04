import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from '@/lib/ai/types'
import type { MessageReferral } from '@/types'
import { SALES_AGENT_CONTEXT_LIMIT, TEST_MARKER } from './types'
import { findTestMarkerCutoff } from './gates'
import { withAdReferralText } from './referral'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string
  ai_context_summary: string | null
  referral: MessageReferral | null
  created_at: string
}

/**
 * Compact conversation context for the Sales Agent LLM.
 * - Caps at 15 turns (after *** cutoff if present)
 * - Outbound quick replies / system ops use ai_context_summary when set
 * - Customer images become a short placeholder
 * - CTWA / FB ads referral is merged into customer turns so the agent
 *   can identify the advertised product from ad copy
 */
export async function buildSalesAgentContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = SALES_AGENT_CONTEXT_LIMIT,
): Promise<{ messages: ChatMessage[]; customerTexts: string[] }> {
  const cutoff = await findTestMarkerCutoff(db, conversationId)

  let query = db
    .from('messages')
    .select(
      'sender_type, content_text, content_type, ai_context_summary, referral, created_at',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(Math.max(limit * 3, 40))

  if (cutoff) {
    query = query.gte('created_at', cutoff)
  }

  const { data, error } = await query
  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const compact: ChatMessage[] = []
  const customerTexts: string[] = []

  for (const m of rows) {
    // Skip reset markers from LLM context (customer *** alone, or inbox Clear).
    if (m.content_text?.includes(TEST_MARKER)) {
      if (m.sender_type === 'customer') {
        if (stripKeepAfterMarker(m.content_text) === '') continue
      } else {
        continue
      }
    }

    const role: 'user' | 'assistant' =
      m.sender_type === 'customer' ? 'user' : 'assistant'

    let content: string | null = null
    if (m.ai_context_summary?.trim()) {
      content = m.ai_context_summary.trim()
    } else if (m.content_type === 'image' && role === 'user') {
      content = withAdReferralText('[customer sent an image]', m.referral) ||
        '[customer sent an image]'
    } else if (m.content_text?.trim() || (role === 'user' && m.referral)) {
      const rawText = m.content_text?.trim()
        ? role === 'user'
          ? stripKeepAfterMarker(m.content_text.trim())
          : m.content_text.trim()
        : ''
      content =
        role === 'user' ? withAdReferralText(rawText, m.referral) || null : rawText
    }

    if (!content) continue
    if (role === 'user') customerTexts.push(content)
    compact.push({ role, content })
  }

  // Keep only the last N turns
  const sliced = compact.slice(-limit)
  const slicedCustomer = customerTexts.slice(
    -Math.min(limit, customerTexts.length),
  )
  return { messages: sliced, customerTexts: slicedCustomer }
}

function stripKeepAfterMarker(text: string): string {
  const idx = text.lastIndexOf(TEST_MARKER)
  if (idx < 0) return text
  return text.slice(idx + TEST_MARKER.length).replace(/^\s+/, '')
}
