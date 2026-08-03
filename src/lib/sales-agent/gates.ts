import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfigWithSales } from './types'
import { DEFAULT_SALES_AGENT_CAPABILITIES } from './types'
import { TEST_MARKER } from './types'

export interface GateResult {
  ok: true
  config: AiConfigWithSales
  /** Conversation row fields needed downstream. */
  conversation: {
    assigned_agent_id: string | null
    ai_autoreply_disabled: boolean
    ai_reply_count: number
    sa_identify_pending: unknown
    sa_last_question_fp: string | null
    sa_order_pending: unknown
  }
  hasHumanTag: boolean
}

export interface GateSkip {
  ok: false
  reason: string
}

/**
 * Load Human tag presence for a contact (case-insensitive name match).
 */
export async function contactHasHumanTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  const { data: tags } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
    .ilike('name', 'human')

  if (!tags || tags.length === 0) return false
  const ids = tags.map((t: { id: string }) => t.id)
  const { data: rows } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .in('tag_id', ids)
    .limit(1)
  return Boolean(rows && rows.length > 0)
}

/**
 * Find the latest customer message containing *** and return its created_at
 * so context builders can ignore earlier history (test reset marker).
 */
export async function findTestMarkerCutoff(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data } = await db
    .from('messages')
    .select('created_at, content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(40)

  if (!data) return null
  for (const row of data as { created_at: string; content_text: string | null }[]) {
    if (row.content_text && row.content_text.includes(TEST_MARKER)) {
      return row.created_at
    }
  }
  return null
}

/** True when the inbound text includes the *** session-reset marker. */
export function inboundHasTestMarker(text: string): boolean {
  return typeof text === 'string' && text.includes(TEST_MARKER)
}

/**
 * Strip the *** marker itself from inbound text for matching / AI.
 */
export function stripTestMarker(text: string): string {
  return text.replace(/\*{3,}/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Clear conversation-scoped Sales Agent memory so the chat is treated as
 * a fresh session from the *** marker onward (bags, identify, dedupe, reply cap).
 */
export async function resetSalesAgentSession(
  db: SupabaseClient,
  conversationId: string,
): Promise<void> {
  await db
    .from('conversations')
    .update({
      sa_order_pending: null,
      sa_identify_pending: null,
      sa_last_question_fp: null,
      sa_last_answered_at: null,
      ai_reply_count: 0,
    })
    .eq('id', conversationId)
}

export function parseSalesCapabilities(row: Record<string, unknown>): {
  salesAgentEnabled: boolean
  productMatch: boolean
  identify: boolean
  customQrMatch: boolean
  aiText: boolean
  createOrder: boolean
  quotation: boolean
  tracking: boolean
  editOrder: boolean
} {
  const bool = (key: string, fallback: boolean) =>
    typeof row[key] === 'boolean' ? (row[key] as boolean) : fallback
  const d = DEFAULT_SALES_AGENT_CAPABILITIES
  return {
    salesAgentEnabled: bool('sales_agent_enabled', d.salesAgentEnabled),
    productMatch: bool('sa_product_match', d.productMatch),
    identify: bool('sa_identify', d.identify),
    customQrMatch: bool('sa_custom_qr_match', d.customQrMatch),
    aiText: bool('sa_ai_text', d.aiText),
    createOrder: bool('sa_create_order', d.createOrder),
    quotation: bool('sa_quotation', d.quotation),
    tracking: bool('sa_tracking', d.tracking),
    editOrder: bool('sa_edit_order', d.editOrder),
  }
}

/**
 * Eligibility gates for Sales Agent. Returns skip reasons silently.
 * `forceManual` (inbox "Reply with AI") skips Human / assigned / paused
 * so a paused thread can still get one agent answer for unanswered mail.
 */
export async function evaluateSalesAgentGates(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    config: AiConfigWithSales | null
    forceManual?: boolean
  },
): Promise<GateResult | GateSkip> {
  const { accountId, conversationId, contactId, config } = args
  const forceManual = args.forceManual === true
  if (!config || !config.autoReplyEnabled) {
    return { ok: false, reason: 'ai_off' }
  }
  if (!config.salesAgentEnabled) {
    return { ok: false, reason: 'sales_agent_off' }
  }

  const hasHumanTag = await contactHasHumanTag(db, accountId, contactId)
  if (hasHumanTag && !forceManual) {
    return { ok: false, reason: 'human_tag' }
  }

  const { data: conv, error } = await db
    .from('conversations')
    .select(
      'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, sa_identify_pending, sa_last_question_fp, sa_order_pending',
    )
    .eq('id', conversationId)
    .maybeSingle()

  if (error || !conv) return { ok: false, reason: 'no_conversation' }
  if (conv.assigned_agent_id && !forceManual) {
    return { ok: false, reason: 'assigned' }
  }
  if (conv.ai_autoreply_disabled && !forceManual) {
    return { ok: false, reason: 'paused' }
  }

  return {
    ok: true,
    config,
    conversation: {
      assigned_agent_id: conv.assigned_agent_id ?? null,
      ai_autoreply_disabled: !!conv.ai_autoreply_disabled,
      ai_reply_count: Number(conv.ai_reply_count) || 0,
      sa_identify_pending: conv.sa_identify_pending,
      sa_last_question_fp: conv.sa_last_question_fp ?? null,
      sa_order_pending: conv.sa_order_pending ?? null,
    },
    hasHumanTag,
  }
}
