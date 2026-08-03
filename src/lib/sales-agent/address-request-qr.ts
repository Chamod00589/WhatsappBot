import type { SupabaseClient } from '@supabase/supabase-js'
import {
  findAddressRequestQr,
  loadCustomQuickReplies,
  type CustomQuickReply,
} from './match-custom-qr'
import {
  sendLocalTextQuickReply,
  sendQuickReplyByCatalogId,
} from './send-quick-reply'
import { CONTEXT_BLURBS } from './types'

/**
 * True when this chat already received the Address Quick Reply
 * (auto-sent after first quotation, or via answer_policy).
 */
export async function hasSentAddressRequestQr(
  db: SupabaseClient,
  conversationId: string,
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('ai_context_summary')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .not('ai_context_summary', 'is', null)
    .order('created_at', { ascending: false })
    .limit(80)

  for (const row of data || []) {
    const s = String(row.ai_context_summary || '').toLowerCase()
    if (!s) continue
    if (s.includes('address quick reply')) return true
    if (s.includes('sent address request')) return true
    if (
      s.includes('request address format') ||
      (s.includes('address format') && s.includes('order'))
    ) {
      return true
    }
  }
  return false
}

/**
 * After the first quotation in a chat, send Address Quick Reply once so the
 * customer gets the order address format without embedding it on every quote.
 * Later product asks only get product QR + quotation again.
 */
export async function maybeSendAddressRequestQrOnce(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** Optional preloaded catalog (avoids a second DB round-trip). */
  customCatalog?: CustomQuickReply[]
}): Promise<{ sent: boolean; note: string }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
  } = args

  if (await hasSentAddressRequestQr(db, conversationId)) {
    return { sent: false, note: 'address QR already sent this chat' }
  }

  const catalog =
    args.customCatalog ?? (await loadCustomQuickReplies(db, accountId))
  const qr = findAddressRequestQr(catalog)
  if (!qr) {
    return { sent: false, note: 'Address Quick Reply not found in catalog' }
  }

  const summary = CONTEXT_BLURBS.addressRequest

  try {
    if (qr.catalog_message_id) {
      await sendQuickReplyByCatalogId({
        db,
        accountId,
        conversationId,
        catalogMessageId: qr.catalog_message_id,
        contextSummary: summary,
      })
      return { sent: true, note: `sent ${qr.title}` }
    }
    if (qr.kind === 'text' && qr.content_text) {
      await sendLocalTextQuickReply({
        db,
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text: qr.content_text,
        contextSummary: summary,
      })
      return { sent: true, note: `sent text ${qr.title}` }
    }
    return { sent: false, note: `${qr.title} has no sendable content` }
  } catch (err) {
    console.error('[sales-agent] address request QR send failed:', err)
    return {
      sent: false,
      note: err instanceof Error ? err.message : 'address QR send failed',
    }
  }
}
