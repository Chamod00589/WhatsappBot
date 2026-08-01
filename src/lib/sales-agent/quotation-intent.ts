import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import type { OrderLineItem } from '@/lib/orders/constants'
import {
  identifyInboundImage,
} from './identify'
import {
  loadProductQuickReplies,
  matchProductByIdentifyName,
} from './match-products'
import {
  extractOrderIntents,
  extractQty,
  resolveLineItems,
  type BagOrderIntent,
} from './order-intent'
import type { MatchableQuickReply } from './match-products'
import { IDENTIFY_CONFIDENCE_THRESHOLD } from './types'

/**
 * True when the customer is asking for prices / a quotation
 * (Singlish, Tanglish, or English), not just browsing a bag.
 */
export function isQuotationRequest(text: string): boolean {
  const t = text.toLowerCase()
  if (!t.trim()) return false

  const priceCue =
    /\b(price|prices|quotation|quote|rate|rates|cost|amount)\b/.test(t) ||
    /\b(kohomada|kohanada|kochchara|kochcara|kiyanna|kiyanawada|kiyala\s+denna)\b/.test(
      t,
    ) ||
    /\b(evlo|evvalavu|price\s+sollu|rate\s+sollu)\b/.test(t) ||
    (/\b(ganna\s+oni|ganne|ganna)\b/.test(t) &&
      /\b(price|kohomada|kohanada|kochchara|evlo)\b/.test(t)) ||
    (/\b(me\s+bags?\s+\d+|bags?\s+\d+\s+ganna)\b/.test(t) &&
      /\b(price|kohomada|kohanada|kochchara|evlo|kiyanna)\b/.test(t))

  return priceCue
}

/** Qty per line when we have N products from a burst. */
export function qtyPerLine(itemCount: number, extractedQty: number): number {
  if (itemCount <= 0) return 1
  if (itemCount === 1) return Math.max(1, extractedQty)
  // "me bags 2" + 2 images → 1 each, not qty 2 on every line
  if (extractedQty === itemCount) return 1
  if (extractedQty > 1 && extractedQty !== itemCount) {
    // Ambiguous multi-bag + higher qty → still 1 each (safer)
    return 1
  }
  return 1
}

/**
 * Resolve quotation line items from named bags in text and/or identified images.
 */
export async function resolveQuotationItems(args: {
  db: SupabaseClient
  accountId: string
  inboundText: string
  catalog: MatchableQuickReply[]
  images?: Array<{ mediaUrl?: string | null; metaMediaId?: string | null }>
  /** Min identify confidence to auto-include (default IDENTIFY_CONFIDENCE_THRESHOLD). */
  minConfidence?: number
}): Promise<{
  items: OrderLineItem[]
  identified: Array<{ product: string; color: string; confidence: number }>
}> {
  const {
    db,
    accountId,
    inboundText,
    catalog,
    images = [],
    minConfidence = IDENTIFY_CONFIDENCE_THRESHOLD,
  } = args

  const namedIntents = extractOrderIntents(
    inboundText ? [inboundText] : [],
    catalog,
  )
  const namedItems = namedIntents.length
    ? await resolveLineItemsWithImages(namedIntents)
    : []

  const identified: Array<{
    product: string
    color: string
    confidence: number
  }> = []
  const imageItems: OrderLineItem[] = []

  for (const img of images) {
    if (!img.metaMediaId && !img.mediaUrl) continue
    try {
      const matches = await identifyInboundImage({
        db,
        accountId,
        mediaUrl: img.mediaUrl,
        metaMediaId: img.metaMediaId,
      })
      const best = matches[0]
      if (!best || best.confidence < minConfidence) continue

      identified.push({
        product: best.product,
        color: best.color,
        confidence: best.confidence,
      })

      const qr = matchProductByIdentifyName(best.product, catalog)
      let price = 0
      let name = best.product
      let image: string | undefined
      let productId = qr?.product_id || undefined

      if (productId) {
        try {
          const p = await fetchCatalogProduct(productId)
          if (p) {
            price = p.price || 0
            name = p.name || name
            image = catalogImageForColor(p, best.color) || p.images[0]
          }
        } catch {
          /* ignore */
        }
      }

      // Skip duplicate of an already-named bag (same product id or name)
      const dup = namedItems.some(
        (n) =>
          (productId && n.productId === productId) ||
          n.name.toLowerCase() === name.toLowerCase(),
      )
      if (dup) continue

      imageItems.push({
        productId,
        name,
        color: best.color || '',
        qty: 1,
        price,
        image,
      })
    } catch (err) {
      console.warn('[sales-agent] quotation identify failed:', err)
    }
  }

  const merged = [...namedItems, ...imageItems]
  if (!merged.length) {
    return { items: [], identified }
  }

  // Named-only: keep extractOrderIntents qty as-is
  if (!imageItems.length) {
    return { items: namedItems, identified }
  }

  const q = qtyPerLine(merged.length, extractQty(inboundText || ''))
  return {
    items: merged.map((it) => ({ ...it, qty: q })),
    identified,
  }
}

async function resolveLineItemsWithImages(
  intents: BagOrderIntent[],
): Promise<OrderLineItem[]> {
  const base = await resolveLineItems(intents)
  const out: OrderLineItem[] = []
  for (let i = 0; i < base.length; i++) {
    const it = base[i]
    const intent = intents[i]
    let image = it.image
    if (!image && intent?.productId) {
      try {
        const p = await fetchCatalogProduct(intent.productId)
        if (p) {
          image = catalogImageForColor(p, intent.color || p.colors[0] || '')
        }
      } catch {
        /* ignore */
      }
    }
    out.push({ ...it, image })
  }
  return out
}
