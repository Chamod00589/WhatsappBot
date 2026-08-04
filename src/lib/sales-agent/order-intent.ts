import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchCatalogProduct,
  fetchCatalogProducts,
  matchCatalogProductByLooseName,
} from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import type { OrderLineItem } from '@/lib/orders/constants'
import { normalizeMatchText } from './normalize'
import {
  matchProductsInText,
  type MatchableQuickReply,
} from './match-products'
import { isAddressLikeMessage } from './actions/orders'
import { findTestMarkerCutoff, stripTestMarker } from './gates'

const TITLE_NOISE =
  /\b(details?\s+)?quick\s*reply\b|\bdetails\b/gi

export function productDisplayName(title: string): string {
  return title.replace(TITLE_NOISE, '').replace(/\s+/g, ' ').trim()
}

/** Common bag colors (Latin) customers use in Singlish/English. */
export const KNOWN_COLORS = [
  'black',
  'white',
  'pink',
  'blue',
  'red',
  'brown',
  'beige',
  'grey',
  'gray',
  'green',
  'yellow',
  'purple',
  'orange',
  'navy',
  'cream',
  'gold',
  'silver',
  'maroon',
  'khaki',
  'olive',
  'wine',
  'nude',
  'tan',
  'coffee',
  'chocolate',
  'ash',
  'mustard',
  'lavender',
  'peach',
  'coral',
  'teal',
  'mint',
  'ivory',
  'off white',
  'offwhite',
  'light blue',
  'dark blue',
  'sky blue',
  'rose gold',
] as const

/**
 * Singlish / casual aliases → canonical Latin color in KNOWN_COLORS.
 * "rathu pata" / "sudu" etc. must resolve so quote/order/edit stay consistent.
 */
export const COLOR_ALIASES: Record<string, (typeof KNOWN_COLORS)[number]> = {
  rathu: 'red',
  rath: 'red',
  ratu: 'red',
  rathtu: 'red',
  sudu: 'white',
  sudhu: 'white',
  kalu: 'black',
  kaalu: 'black',
  nil: 'blue',
  neela: 'blue',
  neel: 'blue',
  kola: 'green',
  pasel: 'green',
  ros: 'pink',
  gulabi: 'pink',
  brownish: 'brown',
  bej: 'beige',
  beigeish: 'beige',
  ashcolor: 'ash',
  ashcolour: 'ash',
}

export interface BagOrderIntent {
  productId: string | null
  catalogMessageId: string | null
  name: string
  color: string | null
  qty: number
  quickReplyId: string
}

export type OrderPendingBag = {
  productId: string | null
  catalogMessageId: string | null
  name: string
  qty: number
  quickReplyId: string
}

export type OrderPendingQuotedItem = {
  productId?: string
  name: string
  color: string
  qty: number
  price: number
  image?: string
}

/** Saved while waiting on color, or after a quotation until address arrives. */
export type OrderPendingState =
  | {
      type: 'awaiting_color'
      bags: OrderPendingBag[]
      addressText: string
      /** Lines that already had color when address arrived (keep as-is). */
      readyItems?: OrderPendingQuotedItem[]
      askedAt: string
    }
  | {
      type: 'awaiting_address'
      items: OrderPendingQuotedItem[]
      /** Set when address arrived but color was still missing. */
      addressText?: string
      askedAt: string
    }

export function parseOrderPending(raw: unknown): OrderPendingState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const askedAt =
    typeof o.askedAt === 'string' ? o.askedAt : new Date().toISOString()

  if (o.type === 'awaiting_address') {
    if (!Array.isArray(o.items) || !o.items.length) return null
    const items = o.items
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => ({
        productId: typeof b.productId === 'string' ? b.productId : undefined,
        name: typeof b.name === 'string' ? b.name : 'Bag',
        color: typeof b.color === 'string' ? b.color : '',
        qty: Math.max(1, Number(b.qty) || 1),
        price: Number(b.price) || 0,
        image: typeof b.image === 'string' ? b.image : undefined,
      }))
      .filter((b) => b.name)
    if (!items.length) return null
    return {
      type: 'awaiting_address',
      items,
      askedAt,
      addressText:
        typeof o.addressText === 'string' ? o.addressText : undefined,
    }
  }

  if (o.type !== 'awaiting_color') return null
  if (!Array.isArray(o.bags) || typeof o.addressText !== 'string') return null
  const readyItems = Array.isArray(o.readyItems)
    ? o.readyItems
        .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
        .map((b) => ({
          productId: typeof b.productId === 'string' ? b.productId : undefined,
          name: typeof b.name === 'string' ? b.name : 'Bag',
          color: typeof b.color === 'string' ? b.color : '',
          qty: Math.max(1, Number(b.qty) || 1),
          price: Number(b.price) || 0,
          image: typeof b.image === 'string' ? b.image : undefined,
        }))
        .filter((b) => b.name)
    : undefined
  return {
    type: 'awaiting_color',
    bags: o.bags
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => ({
        productId: typeof b.productId === 'string' ? b.productId : null,
        catalogMessageId:
          typeof b.catalogMessageId === 'string' ? b.catalogMessageId : null,
        name: typeof b.name === 'string' ? b.name : 'Bag',
        qty: Math.max(1, Number(b.qty) || 1),
        quickReplyId: typeof b.quickReplyId === 'string' ? b.quickReplyId : '',
      })),
    addressText: o.addressText,
    readyItems,
    askedAt,
  }
}

export function extractColorsFromText(text: string): string[] {
  const n = normalizeMatchText(text)
  if (!n) return []
  const found: string[] = []

  // Expand Singlish aliases into Latin color tokens for matching
  let expanded = ` ${n} `
  const aliasKeys = Object.keys(COLOR_ALIASES).sort((a, b) => b.length - a.length)
  for (const alias of aliasKeys) {
    const re = new RegExp(`(?:^|\\s)${escapeReg(alias)}(?:\\s|$)`, 'g')
    expanded = expanded.replace(re, ` ${COLOR_ALIASES[alias]} `)
  }
  // "pata" / "patha" = "color" in Singlish — drop so "rathu pata" → red
  expanded = expanded
    .replace(/\b(pata|patha|paata)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const sorted = [...KNOWN_COLORS].sort((a, b) => b.length - a.length)
  for (const color of sorted) {
    const c = normalizeMatchText(color)
    if (!c) continue
    const re = new RegExp(`(?:^|\\s)${escapeReg(c)}(?:\\s+colou?r)?(?:\\s|$)`)
    if (
      re.test(expanded) ||
      expanded.includes(`${c} color`) ||
      expanded.includes(`${c} colour`)
    ) {
      if (!found.some((f) => f.toLowerCase() === color)) {
        found.push(titleCaseColor(color))
      }
    }
  }
  return found
}

/**
 * Color meant for the PHOTO ("me bag red", "meka white") — not a color that
 * belongs to another named bag in the same message ("… cloudy white ekak").
 */
export function extractColorNearPhotoRef(text: string): string | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return null
  const windows: string[] = []
  for (const m of t.matchAll(
    /\b(?:me\s+bag|this\s+bag|that\s+bag|meka|meke)\b(?:\s+\w+){0,4}/g,
  )) {
    windows.push(m[0])
  }
  for (const m of t.matchAll(
    /(?:\b\w+\s+){0,3}\b(?:me\s+bag|this\s+bag|that\s+bag|meka|meke)\b/g,
  )) {
    windows.push(m[0])
  }
  for (const w of windows) {
    const cols = extractColorsFromText(w)
    if (cols.length) return cols[0]
  }
  return null
}

/**
 * Remove "me bag / this bag …" clauses so named-bag parsing (cloudy ekak)
 * does not inherit qty/color from the photo line ("me bag 2k").
 */
export function stripPhotoReferentialClauses(text: string): string {
  return text
    .replace(
      // Stop at punctuation OR a new named-bag clause ("thawa cloudy…")
      // so we do not need a period between "me bag 2k" and the next ask.
      /\b(?:mata\s+)?(?:me\s+bag|this\s+bag|that\s+bag|meka|meke)\b[^.!?\n]*?(?=(?:\s*[.!?]|\s+\b(?:thawa|then|and|plus|also)\b|$))/gi,
      ' ',
    )
    .replace(/[.!?,;]+/g, '\n')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** True when the whole message is basically just a color choice. */
export function parseColorOnlyReply(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 40) return null
  const colors = extractColorsFromText(trimmed)
  if (colors.length !== 1) return null
  // Avoid treating "black bag" as color-only
  if (/\bbags?\b/i.test(trimmed) && trimmed.split(/\s+/).length > 3) return null
  const n = normalizeMatchText(trimmed)
  const c = normalizeMatchText(colors[0])
  // Mostly the color word (+ color/eka/oni)
  const stripped = n
    .replace(c, '')
    .replace(/\b(colou?r|eka|oni|onne|please|pls|mata|oyata)\b/g, '')
    .trim()
  if (stripped.length > 8) return null
  return colors[0]
}

/**
 * Parse an explicit quantity from text, or null when none is mentioned.
 * Use this when assigning qty per image/line (defaulting to 1 only at the call site).
 */
export function extractExplicitQty(text: string): number | null {
  const t = text.toLowerCase()
  if (!t.trim()) return null

  // "3k ganna oni", "bag 2k", "5k bags", "1kui" typo — Singlish piece count
  const kMatch = t.match(/\b(\d{1,2})\s*k(?:ui|u)?\b/)
  if (kMatch) {
    const n = Number(kMatch[1])
    if (n >= 1 && n <= 20) {
      const qtyCue =
        /\b(ganna|ganne|oni|onne|bags?|pcs?|pieces?|qty|quantity|venum|vaenum|denna)\b/.test(
          t,
        ) ||
        /\b(price|prices|kohomada|kohanada|kochchara|kochcara|kiyanna|evlo)\b/.test(
          t,
        )
      if (qtyCue || n <= 9) return n
    }
  }

  // "1i" / "2i" — common WhatsApp typo for 1k / ekak
  const iMatch = t.match(/\b(\d{1,2})\s*i\b/)
  if (iMatch) {
    const n = Number(iMatch[1])
    if (n >= 1 && n <= 20) return n
  }

  const explicit =
    t.match(/\b(?:qty|quantity|x)\s*[:=]?\s*(\d{1,2})\b/) ||
    t.match(/\b(\d{1,2})\s*(?:x|bags?|pcs?|pieces?)\b/) ||
    t.match(/\b(?:bags?|pcs?|pieces?)\s*[:=]?\s*(\d{1,2})\b/)
  if (explicit) {
    const n = Number(explicit[1])
    if (n >= 1 && n <= 50) return n
  }

  if (/\b(ekak|eka\s*oni|one)\b/.test(t) && !/\b(dekak|thunak|2|3|4|5)\b/.test(t)) {
    return 1
  }
  if (/\b(dekak|dekhak|two)\b/.test(t)) return 2
  if (/\b(thunak|three)\b/.test(t)) return 3
  if (/\b(hatarak|hatharak|four)\b/.test(t)) return 4
  if (/\b(pahak|five)\b/.test(t)) return 5

  if (/\b2\b/.test(t)) return 2
  if (/\b3\b/.test(t)) return 3
  if (/\b4\b/.test(t)) return 4
  if (/\b5\b/.test(t)) return 5

  return null
}

/**
 * All explicit piece-count mentions in order (e.g. "2k" then "3k" → [2, 3]).
 * Used to zip quantities onto multiple images when captions are missing.
 */
export function extractAllQtys(text: string): number[] {
  const t = text.toLowerCase()
  if (!t.trim()) return []
  const positioned: Array<{ idx: number; n: number }> = []

  for (const m of t.matchAll(/\b(\d{1,2})\s*k(?:ui|u)?\b/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= 20) {
      positioned.push({ idx: m.index ?? 0, n })
    }
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*i\b/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= 20) {
      positioned.push({ idx: m.index ?? 0, n })
    }
  }
  if (positioned.length) {
    return positioned.sort((a, b) => a.idx - b.idx).map((p) => p.n)
  }

  for (const m of t.matchAll(
    /\b(?:qty|quantity|x)\s*[:=]?\s*(\d{1,2})\b/g,
  )) {
    const n = Number(m[1])
    if (n >= 1 && n <= 50) {
      positioned.push({ idx: m.index ?? 0, n })
    }
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:bags?|pcs?|pieces?)\b/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= 50) {
      positioned.push({ idx: m.index ?? 0, n })
    }
  }

  const wordMap: Array<[RegExp, number]> = [
    [/\bdekak\b/g, 2],
    [/\bthunak\b/g, 3],
    [/\bhatarak\b/g, 4],
    [/\bpahak\b/g, 5],
  ]
  for (const [re, n] of wordMap) {
    for (const m of t.matchAll(re)) {
      positioned.push({ idx: m.index ?? 0, n })
    }
  }

  return positioned.sort((a, b) => a.idx - b.idx).map((p) => p.n)
}

/**
 * Parse order/quotation quantity from Singlish / Tanglish / English.
 * "3k ganna" → 3 (pieces). Defaults to 1 when nothing is mentioned.
 */
export function extractQty(text: string): number {
  return extractExplicitQty(text) ?? 1
}

/**
 * Qty attached to a photo reference ("this bag 2k", "meka 2i"), not to
 * another named bag in the same sentence ("this bag and puff Pink 2 bags").
 */
export function qtyForThisBagReference(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return null
  // Only allow a short glue word between the photo ref and the number —
  // not another product name ("this bag and puff Pink 2").
  const near = t.match(
    /\b(?:this\s+bag|that\s+bag|me\s+bag|meka|meke)\b(?:\s+(?:eka|eken|x|of|for)){0,2}\s+(\d+)\s*[ik]?\b|\b(\d+)\s*[ik]?\s+(?:x\s+)?(?:of\s+)?(?:this\s+bag|that\s+bag|me\s+bag|meka|meke)\b/,
  )
  if (!near) return null
  const n = Number(near[1] || near[2])
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.floor(n)
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

  // Prefer qty next to "me bag / this bag". Never take "2" from a mixed
  // caption's other product ("me bag … cloudy white ekak" / "puff Pink 2").
  const fromCaptions = captions.map((c) => {
    const raw = c || ''
    const photoQty = qtyForThisBagReference(raw)
    if (photoQty != null) return photoQty
    if (
      looksLikeImageReferentialText(raw) &&
      /\b(puff|mini|bloom|cloudy|bunny|tote|sling|handbag|shoulder)\b/i.test(
        raw,
      )
    ) {
      return null
    }
    return extractExplicitQty(raw)
  })
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

  if (
    imageCount === 1 &&
    fromCaptions[0] == null
  ) {
    const photoQty = qtyForThisBagReference(inboundText || '')
    if (photoQty != null) {
      out[0] = photoQty
    } else if (
      looksLikeImageReferentialText(inboundText || '') &&
      /\b(puff|mini|bloom|cloudy|bunny|tote|sling|handbag|shoulder)\b/i.test(
        inboundText || '',
      )
    ) {
      // "this bag and puff Pink 2 bags" — the 2 belongs to puff, not the photo
      out[0] = 1
    } else if (globalQtys.length >= 1) {
      out[0] = globalQtys[0]
    }
  }

  return out
}

/**
 * Text that refers to the photo just sent ("me bag", "meka 2k") — belongs
 * as an image caption, not a separate named-product ask.
 */
export function looksLikeImageReferentialText(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false
  return (
    /\b(meka|me\s+bag|this\s+bag|that\s+bag|me\s+eka|eka\s+meka)\b/.test(t) ||
    /\b(me\s+bag|bag\s+eka)\s*\d{0,2}\s*k?\b/.test(t) ||
    /^(ok|hari|yes|ow)\b/.test(t)
  )
}

/**
 * Text that names a different bag (e.g. "Mini shoulder red 1i oni") and
 * should NOT be glued onto the previous image caption.
 */
export function looksLikeNamedProductLine(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false
  // Pure photo-referential lines ("meka 2k") are captions, not named bags.
  // Mixed lines ("this bag and puff Pink 2") still name another product.
  if (
    looksLikeImageReferentialText(t) &&
    !/\b(puff|mini|bloom|cloudy|bunny|tote|sling|handbag)\b/.test(t) &&
    !/\b[a-z]{3,}\s+(shoulder|bag|pouch)\b/.test(t)
  ) {
    return false
  }

  // Common catalog tokens / bag words + color or qty cue
  const namedBag =
    /\b(mini|bloom|cloudy|bunny|pouch|shoulder|cross\s*body|tote|sling|handbag|puff)\b/.test(
      t,
    ) || /\b[a-z]{3,}\s+(shoulder|bag|pouch)\b/.test(t)
  const hasColor = extractColorsFromText(t).length > 0
  const hasQty = extractExplicitQty(t) != null
  const buyCue = /\b(oni|onne|ganna|ganne|venum|want|buy)\b/.test(t)

  if (namedBag && (hasColor || hasQty || buyCue)) return true
  if (namedBag && t.split(' ').length >= 2) return true
  return false
}

/**
 * Prefer conversation-saved quotation/identify colors (and qty/price) when
 * the model invents a different color for the same bag.
 *
 * When `preserveExplicitColor` is true (update_order mode=add), an explicit
 * incoming color is kept even if pending has another color for that bag —
 * so White x1 + add Black x2 becomes two lines, not three of one color.
 */
export function applyPendingOverridesToItems(
  items: OrderLineItem[],
  pending: OrderPendingQuotedItem[],
  opts?: { preserveExplicitColor?: boolean },
): OrderLineItem[] {
  if (!items.length || !pending.length) return items
  const preserve = opts?.preserveExplicitColor === true
  return items.map((it) => {
    const name = normalizeMatchText(it.name)
    const incomingColor = String(it.color || '').trim()
    const incomingNorm = normalizeMatchText(incomingColor)

    // Prefer same product+color pending line; else same product.
    const sameProduct = (p: OrderPendingQuotedItem) => {
      const pn = normalizeMatchText(p.name)
      return (
        pn === name ||
        pn.includes(name) ||
        name.includes(pn) ||
        Boolean(it.productId && p.productId && it.productId === p.productId)
      )
    }
    const match =
      (incomingNorm
        ? pending.find(
            (p) =>
              sameProduct(p) &&
              normalizeMatchText(p.color || '') === incomingNorm,
          )
        : undefined) || pending.find(sameProduct)

    if (!match) return it
    const pendingColor = String(match.color || '').trim()

    let color = incomingColor
    if (!incomingColor && pendingColor) {
      color = pendingColor
    } else if (incomingColor && pendingColor && !preserve) {
      // create_order / quote: trust saved identify/quote color over model guess
      color = pendingColor
    } else if (incomingColor) {
      color = incomingColor
    } else {
      color = pendingColor || ''
    }

    return {
      ...it,
      productId: it.productId || match.productId,
      name: match.name || it.name,
      color,
      // Keep explicit qty on add lines; only fall back when missing/invalid
      qty: it.qty >= 1 ? it.qty : match.qty || 1,
      price: it.price > 0 ? it.price : match.price || 0,
      image: it.image || match.image,
    }
  })
}

/**
 * Find bag order intents in one or more customer texts (newest first preferred).
 * Color is taken from the same text window when possible.
 */
export function extractOrderIntents(
  texts: string[],
  catalog: MatchableQuickReply[],
): BagOrderIntent[] {
  const merged = texts.filter(Boolean).join('\n')
  if (!merged.trim()) return []

  const hits = matchProductsInText(merged, catalog)
  if (!hits.length) return []

  const colorsInMerged = extractColorsFromText(merged)
  const fallbackQty = extractQty(merged)
  const out: BagOrderIntent[] = []

  for (const hit of hits) {
    const name = productDisplayName(hit.title)
    // Prefer color mentioned near this product in individual messages
    let color: string | null = null
    let qty: number | null = null
    for (const text of texts) {
      const localHits = matchProductsInText(text, [hit])
      if (!localHits.length) continue
      const localColors = extractColorsFromText(text)
      if (localColors.length && !color) {
        color = localColors[0]
      }
      const localQty = extractExplicitQty(text)
      if (localQty != null && qty == null) qty = localQty
      if (color && qty != null) break
    }
    if (!color && colorsInMerged.length === 1) color = colorsInMerged[0]
    if (!color && colorsInMerged.length > 1) {
      // Multiple colors + multiple bags: assign first unused, else first
      color = colorsInMerged[out.length] || colorsInMerged[0]
    }

    out.push({
      productId: hit.product_id,
      catalogMessageId: hit.catalog_message_id,
      name,
      color,
      qty: qty ?? fallbackQty,
      quickReplyId: hit.id,
    })
  }
  return out
}

export async function resolveLineItems(
  intents: BagOrderIntent[],
): Promise<OrderLineItem[]> {
  let catalog: Awaited<ReturnType<typeof fetchCatalogProducts>> | null = null
  const loadCatalog = async () => {
    if (!catalog) {
      try {
        catalog = await fetchCatalogProducts()
      } catch {
        catalog = []
      }
    }
    return catalog
  }

  const items: OrderLineItem[] = []
  for (const intent of intents) {
    let price = 0
    let name = intent.name
    let image: string | undefined
    let productId = intent.productId || undefined
    let resolvedFromId = false

    if (productId) {
      try {
        const p = await fetchCatalogProduct(productId)
        if (p) {
          resolvedFromId = true
          price = p.price || 0
          name = p.name || name
          image = catalogImageForColor(p, intent.color || p.colors[0] || '')
        }
      } catch {
        /* fall through to loose name match */
      }
    }

    // Canonicalize short names like "Bloom Bag" → "Bloom Shoulder Bag"
    if (!resolvedFromId) {
      const all = await loadCatalog()
      const matched = matchCatalogProductByLooseName(all, intent.name)
      if (matched) {
        productId = matched.id
        name = matched.name
        if (!price) price = matched.price || 0
        if (!image) {
          image = catalogImageForColor(
            matched,
            intent.color || matched.colors[0] || '',
          )
        }
      }
    }

    items.push({
      productId,
      name,
      color: intent.color || '',
      qty: intent.qty,
      price,
      image,
    })
  }
  return items
}

/**
 * Catalog message ids / QR ids already sent as product quick replies
 * in this conversation (so we don't resend the same bag details).
 */
export async function loadAlreadySentProductKeys(
  db: SupabaseClient,
  conversationId: string,
  catalog: MatchableQuickReply[],
): Promise<Set<string>> {
  const cutoff = await findTestMarkerCutoff(db, conversationId)
  let query = db
    .from('messages')
    .select('content_text, ai_context_summary, created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(100)
  if (cutoff) query = query.gte('created_at', cutoff)

  const { data } = await query

  const blob = ((data ?? []) as Array<{
    content_text: string | null
    ai_context_summary: string | null
  }>)
    .map((m) => `${m.content_text || ''}\n${m.ai_context_summary || ''}`)
    .join('\n')
    .toLowerCase()

  const sent = new Set<string>()
  for (const p of catalog) {
    const key = p.catalog_message_id || p.id
    const title = productDisplayName(p.title).toLowerCase()
    const stub = (p.title || '').toLowerCase()
    const catalogId = (p.catalog_message_id || '').toLowerCase()
    if (
      (stub && blob.includes(stub)) ||
      (title && title.length >= 4 && blob.includes(title)) ||
      (catalogId && blob.includes(catalogId)) ||
      (title && blob.includes(`sent product quick reply: ${title}`))
    ) {
      sent.add(key)
    }
  }
  return sent
}

export async function loadRecentCustomerTexts(
  db: SupabaseClient,
  conversationId: string,
  limit = 12,
): Promise<string[]> {
  const cutoff = await findTestMarkerCutoff(db, conversationId)
  let query = db
    .from('messages')
    .select('content_text, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (cutoff) query = query.gte('created_at', cutoff)

  const { data } = await query

  return ((data ?? []) as Array<{ content_text: string | null }>)
    .map((m) => stripTestMarker((m.content_text || '').trim()))
    .filter(Boolean)
}

/**
 * Products we already offered (sent QR) in this chat — used when the
 * customer later pastes only an address without repeating the bag name.
 * Prefers identify / explicit "sent product quick reply" summaries over
 * loose title substring matches in old message bodies.
 */
export async function loadRecentlyOfferedProducts(
  db: SupabaseClient,
  conversationId: string,
  catalog: MatchableQuickReply[],
  limit = 40,
): Promise<MatchableQuickReply[]> {
  const cutoff = await findTestMarkerCutoff(db, conversationId)
  let query = db
    .from('messages')
    .select('content_text, ai_context_summary, created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (cutoff) query = query.gte('created_at', cutoff)

  const { data } = await query

  const rows = (data ?? []) as Array<{
    content_text: string | null
    ai_context_summary: string | null
  }>

  const strongBlob = rows
    .map((m) => (m.ai_context_summary || '').toLowerCase())
    .join('\n')

  const offered: MatchableQuickReply[] = []
  const seen = new Set<string>()

  const tryPush = (p: MatchableQuickReply) => {
    const key = p.catalog_message_id || p.id
    if (seen.has(key)) return
    seen.add(key)
    offered.push(p)
  }

  // Pass 1: strong signals from identify / product QR context summaries
  for (const p of catalog) {
    if (!p.product_id) continue
    const title = productDisplayName(p.title).toLowerCase()
    const catalogId = (p.catalog_message_id || '').toLowerCase()
    const first = title.split(' ')[0] || ''
    const hit =
      (catalogId && strongBlob.includes(catalogId)) ||
      (title.length >= 4 &&
        (strongBlob.includes(`sent product quick reply for ${title}`) ||
          strongBlob.includes(`sent product quick reply: ${title}`) ||
          strongBlob.includes(`sent product quick reply for ${first}`) ||
          (strongBlob.includes('after image identify') &&
            first.length >= 4 &&
            strongBlob.includes(first)) ||
          (first.length >= 4 &&
            strongBlob.includes(`confirmed identify: ${first}`))))
    if (hit) tryPush(p)
  }

  // Pass 2: only if nothing found — looser title match on summaries
  if (!offered.length) {
    for (const p of catalog) {
      if (!p.product_id) continue
      const title = productDisplayName(p.title).toLowerCase()
      if (title.length >= 5 && strongBlob.includes(title)) tryPush(p)
    }
  }

  return offered
}

/**
 * Resolve bag/color/qty for an address message from recent customer text
 * and/or products we already sent as QRs (identify / product match).
 *
 * Prefer bags the customer already named in chat history (e.g. "cloudy eke
 * black eka") over loosely matched offered QRs. Only fall back to offered
 * product-backed QRs when history has no bag mention.
 */
export function resolveOrderIntentsForAddress(args: {
  customerTexts: string[]
  catalog: MatchableQuickReply[]
  offeredProducts: MatchableQuickReply[]
}): BagOrderIntent[] {
  const { customerTexts, catalog, offeredProducts } = args
  const addressText = customerTexts[0] || ''
  const priorTexts = customerTexts.slice(1)

  const fromAddress = extractOrderIntents(
    addressText ? [addressText] : [],
    catalog,
  )
  if (fromAddress.length) return fromAddress

  // History bag mentions win (cloudy + black before address)
  const fromPrior = extractOrderIntents(priorTexts, catalog)
  if (fromPrior.length) return fromPrior

  // Also try full join in case ordering dropped a line
  const fromAll = extractOrderIntents(
    customerTexts.filter(Boolean),
    catalog,
  )
  if (fromAll.length) return fromAll

  const productOffered = offeredProducts.filter((p) => Boolean(p.product_id))
  if (!productOffered.length) return []

  const mergedPrior = priorTexts.filter(Boolean).join('\n')
  const colors = extractColorsFromText(
    [addressText, mergedPrior].filter(Boolean).join('\n'),
  )
  const qty = extractQty(mergedPrior || addressText)

  return productOffered.map((p, i) => ({
    productId: p.product_id,
    catalogMessageId: p.catalog_message_id,
    name: productDisplayName(p.title),
    color: colors[i] || (colors.length === 1 ? colors[0] : null),
    qty,
    quickReplyId: p.id,
  }))
}

export function buildColorAskText(
  bags: Array<{ name: string }>,
  useSinglish: boolean,
  availableColors?: string[],
): string {
  const names = bags.map((b) => b.name).join(', ')
  const colorHint =
    availableColors && availableColors.length
      ? availableColors.slice(0, 8).join(' / ')
      : 'black / white / pink…'
  if (useSinglish) {
    return `${names} eka ganna color eka saha qty kiyanna. (${colorHint})`
  }
  return `${names} ku ethu color + qty venum? (${colorHint})`
}

export function shouldRunOrderIntake(inboundText: string): boolean {
  return isAddressLikeMessage(inboundText)
}

/** Stable key: same bag + same color upserts; different colors stay separate. */
export function requestedItemKey(item: {
  productId?: string | null
  name: string
  color?: string | null
}): string {
  const color = normalizeMatchText(item.color || '') || '_'
  if (item.productId) return `id:${item.productId}|c:${color}`
  return `name:${normalizeMatchText(item.name)}|c:${color}`
}

/**
 * Merge conversation-scoped requested bags.
 * - Same product+color → qty summed / fields refreshed
 * - Different color → separate line (White + Black both kept)
 * - Incoming empty color with existing colored line(s) for that product →
 *   keep prior color(s); do not insert a blank-color duplicate
 */
export function mergeRequestedItems(
  existing: OrderPendingQuotedItem[],
  incoming: OrderPendingQuotedItem[],
): OrderPendingQuotedItem[] {
  const map = new Map<string, OrderPendingQuotedItem>()
  for (const it of existing) {
    if (!it?.name) continue
    map.set(requestedItemKey(it), { ...it, qty: Math.max(1, it.qty || 1) })
  }
  for (const it of incoming) {
    if (!it?.name) continue
    const incomingColor = String(it.color || '').trim()

    // Colorless upsert: refresh matching product line(s) without inventing
    // a blank-color row (would later default to catalog black on quote).
    if (!incomingColor) {
      const productKey = it.productId
        ? `id:${it.productId}`
        : `name:${normalizeMatchText(it.name)}`
      const siblings = [...map.entries()].filter(([k]) =>
        k.startsWith(`${productKey}|c:`),
      )
      if (siblings.length === 1) {
        const [key, prev] = siblings[0]
        map.set(key, {
          ...prev,
          productId: it.productId || prev.productId,
          name: it.name || prev.name,
          qty: it.qty >= 1 ? it.qty : prev.qty,
          price: Number(it.price) > 0 ? Number(it.price) : prev.price,
          image: it.image || prev.image,
        })
        continue
      }
      if (siblings.length > 1) {
        // Multiple colors already on file — ignore colorless touch
        continue
      }
      // No prior line for this product — store as-is (color still empty)
    }

    const key = requestedItemKey(it)
    const prev = map.get(key)
    if (!prev) {
      map.set(key, {
        productId: it.productId,
        name: it.name,
        color: incomingColor,
        qty: Math.max(1, it.qty || 1),
        price: Number(it.price) || 0,
        image: it.image,
      })
      continue
    }
    map.set(key, {
      productId: it.productId || prev.productId,
      name: it.name || prev.name,
      color: incomingColor || prev.color,
      qty: it.qty >= 1 ? it.qty : prev.qty,
      price: Number(it.price) > 0 ? Number(it.price) : prev.price,
      image: it.image || prev.image,
    })
  }
  return Array.from(map.values())
}

export function quotedItemsFromPending(
  pending: OrderPendingState | null,
): OrderPendingQuotedItem[] {
  if (pending?.type === 'awaiting_address') return pending.items
  return []
}

export function toOrderLineItems(
  items: OrderPendingQuotedItem[],
): OrderLineItem[] {
  return items.map((it) => ({
    productId: it.productId,
    name: it.name,
    color: it.color || '',
    qty: Math.max(1, it.qty || 1),
    price: Number(it.price) || 0,
    image: it.image,
  }))
}

export function toPendingQuotedItems(
  items: OrderLineItem[],
): OrderPendingQuotedItem[] {
  return items.map((it) => ({
    productId: it.productId,
    name: it.name,
    color: it.color || '',
    qty: Math.max(1, it.qty || 1),
    price: Number(it.price) || 0,
    image: it.image,
  }))
}

/**
 * Load + merge + save awaiting_address items (conversation bag memory).
 * Does not clobber an awaiting_color latch that still holds an address.
 */
export async function upsertAwaitingAddressItems(
  db: SupabaseClient,
  conversationId: string,
  incoming: OrderPendingQuotedItem[],
): Promise<OrderPendingQuotedItem[]> {
  if (!incoming.length) return []

  const { data } = await db
    .from('conversations')
    .select('sa_order_pending')
    .eq('id', conversationId)
    .maybeSingle()

  const prev = parseOrderPending(data?.sa_order_pending)
  if (prev?.type === 'awaiting_color') {
    // Keep address latch; only refresh bag list for the color ask.
    const bags: OrderPendingBag[] = mergeRequestedItems(
      prev.bags.map((b) => ({
        productId: b.productId || undefined,
        name: b.name,
        color: '',
        qty: b.qty,
        price: 0,
      })),
      incoming,
    ).map((it) => ({
      productId: it.productId ?? null,
      catalogMessageId: null,
      name: it.name,
      qty: it.qty,
      quickReplyId: '',
    }))
    await db
      .from('conversations')
      .update({
        sa_order_pending: {
          type: 'awaiting_color',
          bags,
          addressText: prev.addressText,
          askedAt: new Date().toISOString(),
        } satisfies OrderPendingState,
      })
      .eq('id', conversationId)
    return incoming
  }

  const existing = quotedItemsFromPending(prev)
  const merged = mergeRequestedItems(existing, incoming)
  await db
    .from('conversations')
    .update({
      sa_order_pending: {
        type: 'awaiting_address',
        items: merged,
        askedAt: new Date().toISOString(),
      } satisfies OrderPendingState,
    })
    .eq('id', conversationId)
  return merged
}

/**
 * Patch color on saved requested items. If `targetName` matches one bag,
 * only that line changes; otherwise all lines update (common Singlish
 * "mata rathu pata bag eka denna" after a single bag was identified).
 */
export function patchRequestedItemsColor(
  items: OrderPendingQuotedItem[],
  newColor: string,
  targetName?: string | null,
): OrderPendingQuotedItem[] {
  const color = newColor.trim()
  if (!color || !items.length) return items
  const target = targetName ? normalizeMatchText(targetName) : ''
  return items.map((it) => {
    if (target) {
      const n = normalizeMatchText(it.name)
      if (!n.includes(target) && !target.includes(n)) return it
    }
    return { ...it, color }
  })
}

function titleCaseColor(color: string): string {
  return color
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
