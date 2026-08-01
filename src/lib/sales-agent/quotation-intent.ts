import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import type { OrderLineItem } from '@/lib/orders/constants'
import {
  identifyInboundImage,
} from './identify'
import {
  matchProductByIdentifyName,
} from './match-products'
import {
  extractAllQtys,
  extractColorsFromText,
  extractExplicitQty,
  extractOrderIntents,
  resolveLineItems,
  type BagOrderIntent,
} from './order-intent'
import type { MatchableQuickReply } from './match-products'
import { IDENTIFY_CONFIDENCE_THRESHOLD } from './types'

export type QuotationImageInput = {
  mediaUrl?: string | null
  metaMediaId?: string | null
  /** Caption and/or following text tied to this image in the burst. */
  caption?: string | null
}

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
      /\b(price|kohomada|kohanada|kochchara|evlo|kiyanna)\b/.test(t)) ||
    // Multi-image buy asks: "2k ganna" / "meka 3k" on each photo
    (/\b\d{1,2}\s*k\b/.test(t) &&
      /\b(ganna|ganne|oni|onne|bags?|meka|mata)\b/.test(t))

  return priceCue
}

/**
 * Assign a qty to each image line from its caption, else zip global qty
 * mentions onto images in order, else 1.
 */
export function assignQtysToImageLines(
  imageCount: number,
  captions: Array<string | null | undefined>,
  inboundText: string,
): number[] {
  if (imageCount <= 0) return []

  const fromCaptions = captions.map((c) => extractExplicitQty(c || ''))
  const allHaveCaptionQty = fromCaptions.every((q) => q != null)
  if (allHaveCaptionQty) {
    return fromCaptions.map((q) => q as number)
  }

  const globalQtys = extractAllQtys(inboundText || '')
  const out: number[] = []
  let zipIdx = 0
  for (let i = 0; i < imageCount; i++) {
    if (fromCaptions[i] != null) {
      out.push(fromCaptions[i] as number)
      continue
    }
    if (zipIdx < globalQtys.length) {
      out.push(globalQtys[zipIdx++])
      continue
    }
    out.push(1)
  }

  // If no per-caption qty and exactly one global qty + one image → that qty
  if (
    imageCount === 1 &&
    fromCaptions[0] == null &&
    globalQtys.length >= 1
  ) {
    out[0] = globalQtys[0]
  }

  return out
}

/** @deprecated Prefer assignQtysToImageLines for multi-image bursts. */
export function qtyPerLine(itemCount: number, extractedQty: number): number {
  if (itemCount <= 0) return 1
  if (itemCount === 1) return Math.max(1, extractedQty)
  if (extractedQty === itemCount) return 1
  if (extractedQty > 1 && extractedQty !== itemCount) return 1
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
  images?: QuotationImageInput[]
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

  // Split burst into lines so each bag can pick qty/color from its own line
  const textLines = (inboundText || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
  const namedIntents = extractOrderIntents(
    textLines.length ? textLines : inboundText ? [inboundText] : [],
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
  const imageCaptions: string[] = []

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

      const caption = (img.caption || '').trim()
      let color = best.color || ''
      if (caption) {
        const cols = extractColorsFromText(caption)
        if (cols.length) color = cols[0]
      }

      imageCaptions.push(caption)
      imageItems.push({
        productId,
        name,
        color: color || '',
        qty: 1, // filled below
        price,
        image,
      })
    } catch (err) {
      console.warn('[sales-agent] quotation identify failed:', err)
    }
  }

  if (imageItems.length) {
    const qtys = assignQtysToImageLines(
      imageItems.length,
      imageCaptions,
      inboundText || '',
    )
    for (let i = 0; i < imageItems.length; i++) {
      imageItems[i].qty = qtys[i] ?? 1
    }
  }

  const merged = [...namedItems, ...imageItems]
  if (!merged.length) {
    return { items: [], identified }
  }

  // Keep per-line / per-image qty — do NOT overwrite with a single global qty
  return { items: merged, identified }
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
