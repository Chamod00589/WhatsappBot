import type { SupabaseClient } from '@supabase/supabase-js'
import { identifyInboundImage } from './identify'
import { extractExplicitQty } from './order-intent'
import { normalizeMatchText } from './normalize'
import { CONTEXT_BLURBS } from './types'
import {
  fetchCatalogProduct,
  fetchCatalogProducts,
  matchCatalogProductByLooseName,
  resolveCatalogImageUrl,
  type CatalogProduct,
} from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import { isAddToOrderRequest } from './order-edit-intent'

export type ReplyReferenceBag = {
  productName: string
  color: string
  productId?: string
  qty?: number
  source: 'catalog_image' | 'identify' | 'summary'
  mediaUrl?: string | null
  summary?: string | null
}

/**
 * When the customer swipe-replies to a bot product image / QR, resolve
 * which bag+color they meant ("me color eken" → that image's color).
 */
export async function resolveReplyReference(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  replyToMessageId: string
  /** Customer text on the reply (for qty). */
  inboundText?: string
}): Promise<ReplyReferenceBag | null> {
  const { db, accountId, conversationId, replyToMessageId } = args
  const qty = extractExplicitQty(args.inboundText || '') ?? undefined

  const { data: msg, error } = await db
    .from('messages')
    .select(
      'id, content_type, content_text, media_url, ai_context_summary, sender_type',
    )
    .eq('id', replyToMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error || !msg) return null

  const summary =
    typeof msg.ai_context_summary === 'string'
      ? msg.ai_context_summary
      : null
  const mediaUrl =
    typeof msg.media_url === 'string' && msg.media_url.trim()
      ? msg.media_url.trim()
      : null
  const contentText =
    typeof msg.content_text === 'string' ? msg.content_text.trim() : ''

  // Quotation / order-confirm cards are multi-bag composites — never
  // vision-identify them into a single wrong bag (e.g. Tape Bag).
  if (isCompositeOrderCardSummary(summary)) {
    return null
  }

  // 1) Match replied image URL to a catalog color slot (fast, exact)
  if (mediaUrl && msg.content_type === 'image') {
    const byUrl = await matchProductColorByImageUrl(mediaUrl)
    if (byUrl) {
      return {
        productName: byUrl.name,
        color: byUrl.color,
        productId: byUrl.productId,
        qty,
        source: 'catalog_image',
        mediaUrl,
        summary,
      }
    }

    // 2) Vision identify the quoted image (authoritative for "me color")
    try {
      const matches = await identifyInboundImage({
        db,
        accountId,
        mediaUrl,
        metaMediaId: null,
      })
      const best = matches[0]
      if (best?.product) {
        return {
          productName: best.product,
          color: best.color || '',
          qty,
          source: 'identify',
          mediaUrl,
          summary,
        }
      }
    } catch (err) {
      console.warn('[sales-agent] reply-image identify failed:', err)
    }
  }

  // 3) Parse "Sent product quick reply for X (Color)" from summary
  const fromSummary = parseProductColorFromSummary(summary || contentText)
  if (fromSummary) {
    let productId: string | undefined
    try {
      const catalog = await fetchCatalogProducts()
      const hit = matchCatalogProductByLooseName(catalog, fromSummary.productName)
      productId = hit?.id
      if (hit && fromSummary.color) {
        const canon =
          hit.colors.find(
            (c) => c.toLowerCase() === fromSummary.color.toLowerCase(),
          ) || fromSummary.color
        return {
          productName: hit.name,
          color: canon,
          productId,
          qty,
          source: 'summary',
          mediaUrl,
          summary,
        }
      }
    } catch {
      /* keep parsed */
    }
    return {
      productName: fromSummary.productName,
      color: fromSummary.color,
      productId,
      qty,
      source: 'summary',
      mediaUrl,
      summary,
    }
  }

  return null
}

/** Parse compact AI summaries / titles for product + color. */
export function parseProductColorFromSummary(
  text: string,
): { productName: string; color: string } | null {
  const t = (text || '').trim()
  if (!t) return null

  // "Sent product quick reply for Cloudy Shoulder Bag (White) after…"
  const m1 = t.match(
    /(?:quick reply for|for)\s+(.+?)\s*\(([^)]+)\)/i,
  )
  if (m1) {
    return {
      productName: m1[1].replace(/\s+details?\s+quick\s*reply$/i, '').trim(),
      color: m1[2].trim(),
    }
  }

  // "Cloudy Shoulder Bag (Brown)"
  const m2 = t.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (m2 && m2[1].length > 2) {
    return {
      productName: m2[1].replace(/\s+details?\s+quick\s*reply$/i, '').trim(),
      color: m2[2].trim(),
    }
  }

  return null
}

function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`.replace(/\/$/, '').toLowerCase()
  } catch {
    return url.split('?')[0].replace(/\/$/, '').toLowerCase()
  }
}

async function matchProductColorByImageUrl(
  mediaUrl: string,
): Promise<{ productId: string; name: string; color: string } | null> {
  const target = normalizeUrlKey(mediaUrl)
  const targetBase = target.split('/').pop() || ''

  let catalog: CatalogProduct[] = []
  try {
    catalog = await fetchCatalogProducts()
  } catch {
    return null
  }

  for (const p of catalog) {
    for (let i = 0; i < p.images.length; i++) {
      const resolved = resolveCatalogImageUrl(p.images[i] || '')
      if (!resolved) continue
      const key = normalizeUrlKey(resolved)
      const base = key.split('/').pop() || ''
      if (
        key === target ||
        (targetBase && base && targetBase === base) ||
        key.includes(targetBase) ||
        target.includes(base)
      ) {
        const color =
          p.colors[i] ||
          p.colors[Math.min(i, Math.max(0, p.colors.length - 1))] ||
          ''
        if (!color && !p.name) continue
        return {
          productId: p.id,
          name: p.name,
          color: color || p.colors[0] || '',
        }
      }
    }
  }
  return null
}

/**
 * Persist reply-referenced bag into conversation memory so quote/order
 * use that color instead of an older identify color.
 */
export async function applyReplyReferenceToPending(args: {
  db: SupabaseClient
  conversationId: string
  ref: ReplyReferenceBag
}): Promise<void> {
  const { db, conversationId, ref } = args
  if (!ref.productName) return

  let price = 0
  let image: string | undefined
  let name = ref.productName
  let productId = ref.productId

  if (productId) {
    try {
      const p = await fetchCatalogProduct(productId)
      if (p) {
        name = p.name || name
        price = p.price || 0
        image = catalogImageForColor(p, ref.color || p.colors[0] || '')
      }
    } catch {
      /* ignore */
    }
  } else {
    try {
      const catalog = await fetchCatalogProducts()
      const hit = matchCatalogProductByLooseName(catalog, ref.productName)
      if (hit) {
        productId = hit.id
        name = hit.name
        price = hit.price || 0
        image = catalogImageForColor(hit, ref.color || hit.colors[0] || '')
      }
    } catch {
      /* ignore */
    }
  }

  const { upsertAwaitingAddressItems } = await import('./order-intent')
  await upsertAwaitingAddressItems(db, conversationId, [
    {
      productId,
      name,
      color: ref.color || '',
      qty: Math.max(1, ref.qty || 1),
      price,
      image,
    },
  ])
}

/** True when swipe target is a quotation / order-confirm screenshot. */
export function isCompositeOrderCardSummary(
  summary: string | null | undefined,
): boolean {
  const s = (summary || '').trim().toLowerCase()
  if (!s) return false
  if (s === CONTEXT_BLURBS.orderConfirm.toLowerCase()) return true
  if (s === CONTEXT_BLURBS.quotation.toLowerCase()) return true
  if (s.includes('order confirm')) return true
  if (s.includes('quotation msg')) return true
  return false
}

/**
 * Persist reply-ref into pending only for color picks — never for
 * "me bag ekath denna" (add), which would double-count with cart extract.
 */
export function shouldApplyReplyRefToPending(text: string): boolean {
  if (!text.trim()) return false
  if (isAddToOrderRequest(text)) return false
  return looksLikeReplyColorAsk(text)
}

/** True when customer text points at the swipe-replied media ("me color"). */
export function looksLikeReplyColorAsk(text: string): boolean {
  const t = normalizeMatchText(text)
  if (!t) return false
  return (
    /\b(me|meka|this|that)\s+(color|colour|pata|patha)\b/.test(t) ||
    /\b(color|colour|pata)\s+eken\b/.test(t) ||
    /\bme\s+color\b/.test(t) ||
    looksLikeImageReferentialLoose(t)
  )
}

function looksLikeImageReferentialLoose(t: string): boolean {
  return /\b(meka|me\s+bag|this\s+bag)\b/.test(t)
}
