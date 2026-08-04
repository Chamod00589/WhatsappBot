import type { SupabaseClient } from '@supabase/supabase-js'
import { parseOrderPending, productDisplayName } from './order-intent'
import {
  matchProductsInText,
  type MatchableQuickReply,
} from './match-products'
import { sendQuickReplyByCatalogId } from './send-quick-reply'
import { normalizeMatchText } from './normalize'

/**
 * Customer is asking what colors / details a bag has
 * (e.g. "Me bag eke thawa monawda colors thiyenne").
 */
export function isProductDetailsOrColorsAsk(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false

  const colorAsk =
    /\b(colors?|colours?|pata|patha|paata)\b/.test(t) &&
    /\b(thiyenne|thiyenwda|thiyenawada|monawada|monawda|mokakda|what|which|available|wenas|thawa)\b/.test(
      t,
    )

  const detailsAsk =
    /\b(details?|detail|info|information|photos?|images?|pics?)\b/.test(t) &&
    /\b(bag|bags|eka|eketh|ekath|meka|me|product)\b/.test(t)

  // "photos ewanawada / images denna" without a buy/price ask
  const sendPhotosAsk =
    /\b(photos?|images?|pics?)\b/.test(t) &&
    /\b(ewanawada|ewanna|penna|pennanna|send|show)\b/.test(t) &&
    !/\b(price|prices|kochchara|quotation|quote|ganna\s+oni)\b/.test(t)

  const showBagAsk =
    /\b(bag|bags)\b/.test(t) &&
    /\b(details?|colors?|colours?|show|penna|pennanna|kiyanna)\b/.test(t) &&
    !/\b(price|prices|kochchara|quotation|quote|deliver|delivery)\b/.test(t)

  // "me bag eke ... colors"
  const meBagColors =
    /\b(me|meka|meeke|me\s*bag|meka\s*bag)\b/.test(t) &&
    /\b(colors?|colours?|pata|details?)\b/.test(t)

  return colorAsk || detailsAsk || sendPhotosAsk || showBagAsk || meBagColors
}

/**
 * True when this chat already sent the product Details QR for this bag.
 */
export async function hasSentProductQr(
  db: SupabaseClient,
  conversationId: string,
  opts: {
    productId?: string | null
    catalogMessageId?: string | null
    bagName?: string | null
  },
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('ai_context_summary')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .not('ai_context_summary', 'is', null)
    .order('created_at', { ascending: false })
    .limit(100)

  const name = normalizeMatchText(opts.bagName || '')
  const pid = (opts.productId || '').trim().toLowerCase()
  const cat = (opts.catalogMessageId || '').trim().toLowerCase()

  for (const row of data || []) {
    const s = String(row.ai_context_summary || '')
    const sl = s.toLowerCase()
    if (!sl.includes('product quick reply') && !sl.includes('product details')) {
      continue
    }
    if (pid && sl.includes(pid)) return true
    if (cat && sl.includes(cat)) return true
    if (name && normalizeMatchText(s).includes(name)) return true
  }
  return false
}

/**
 * Resolve which product QR to send for a details/colors ask.
 * Prefers session pending quote ("me bag"), then named bag in text.
 */
export function resolveProductForDetailsAsk(args: {
  burstText: string
  orderPending: unknown
  productCatalog: MatchableQuickReply[]
}): MatchableQuickReply | null {
  const { burstText, orderPending, productCatalog } = args
  const pending = parseOrderPending(orderPending)

  const pendingItems =
    pending?.type === 'awaiting_address'
      ? pending.items
      : pending?.type === 'awaiting_color'
        ? [
            ...(pending.readyItems || []),
            ...pending.bags.map((b) => ({
              productId: b.productId || undefined,
              name: b.name,
            })),
          ]
        : []

  const meBag =
    /\b(me|meka|meeke|me\s*bag|meka\s*bag|e\s*bag|eka)\b/i.test(burstText) ||
    /\bthawa\s+monaw/.test(burstText.toLowerCase())

  // "me bag" → last / only pending product
  if (meBag && pendingItems.length) {
    const last = pendingItems[pendingItems.length - 1]
    if (last.productId) {
      const hit = productCatalog.find((p) => p.product_id === last.productId)
      if (hit) return hit
    }
    const byName = matchProductsInText(last.name || '', productCatalog)
    if (byName[0]) return byName[0]
  }

  // Named bag in the message
  const named = matchProductsInText(burstText, productCatalog)
  if (named.length === 1) return named[0]
  if (named.length > 1 && pendingItems.length) {
    const pendingIds = new Set(
      pendingItems.map((i) => i.productId).filter(Boolean),
    )
    const overlap = named.find((n) => n.product_id && pendingIds.has(n.product_id))
    if (overlap) return overlap
  }
  if (named[0]) return named[0]

  // Fallback: single pending bag in session
  if (pendingItems.length === 1) {
    const only = pendingItems[0]
    if (only.productId) {
      return (
        productCatalog.find((p) => p.product_id === only.productId) || null
      )
    }
  }

  return null
}

/**
 * When the customer asks for colors/details, send that product's Details QR.
 * Product QRs are once-per-chat unless this is an explicit ask again.
 */
export async function maybeSendProductDetailsQr(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  burstText: string
  orderPending: unknown
  productCatalog: MatchableQuickReply[]
  /** When true, re-send even if already sent this chat (customer asked again). */
  forceResend?: boolean
}): Promise<{ sent: boolean; note: string; productName?: string }> {
  const {
    db,
    accountId,
    conversationId,
    burstText,
    orderPending,
    productCatalog,
  } = args

  if (!isProductDetailsOrColorsAsk(burstText)) {
    return { sent: false, note: 'not a product details/colors ask' }
  }

  const hit = resolveProductForDetailsAsk({
    burstText,
    orderPending,
    productCatalog,
  })
  if (!hit?.catalog_message_id) {
    return { sent: false, note: 'no product resolved for details ask' }
  }

  const display = hit.bagName || productDisplayName(hit.title)
  const already = await hasSentProductQr(db, conversationId, {
    productId: hit.product_id,
    catalogMessageId: hit.catalog_message_id,
    bagName: display,
  })

  // Once per chat — but an explicit colors/details ask counts as "asks again"
  const force = args.forceResend !== false
  if (already && !force) {
    return {
      sent: false,
      note: `product QR already sent this chat: ${display}`,
      productName: display,
    }
  }

  // Explicit ask → always allow re-send; first ask → send
  await sendQuickReplyByCatalogId({
    db,
    accountId,
    conversationId,
    catalogMessageId: hit.catalog_message_id,
    contextSummary: `Sent product quick reply for ${display} (colors/details ask)`,
  })

  return {
    sent: true,
    note: `sent product details QR: ${display}`,
    productName: display,
  }
}
