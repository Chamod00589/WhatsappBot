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
      askedAt: string
    }
  | {
      type: 'awaiting_address'
      items: OrderPendingQuotedItem[]
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
    return { type: 'awaiting_address', items, askedAt }
  }

  if (o.type !== 'awaiting_color') return null
  if (!Array.isArray(o.bags) || typeof o.addressText !== 'string') return null
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
    askedAt,
  }
}

export function extractColorsFromText(text: string): string[] {
  const n = normalizeMatchText(text)
  if (!n) return []
  const found: string[] = []
  // Longer phrases first
  const sorted = [...KNOWN_COLORS].sort((a, b) => b.length - a.length)
  for (const color of sorted) {
    const c = normalizeMatchText(color)
    if (!c) continue
    const re = new RegExp(`(?:^|\\s)${escapeReg(c)}(?:\\s+colou?r)?(?:\\s|$)`)
    if (re.test(n) || n.includes(`${c} color`) || n.includes(`${c} colour`)) {
      if (!found.some((f) => f.toLowerCase() === color)) {
        found.push(titleCaseColor(color))
      }
    }
  }
  return found
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

  // "3k ganna oni", "bag 2k", "5k bags" — Singlish piece count (k = කීපයක්)
  const kMatch = t.match(/\b(\d{1,2})\s*k\b/)
  if (kMatch) {
    const n = Number(kMatch[1])
    if (n >= 1 && n <= 20) {
      const qtyCue =
        /\b(ganna|ganne|oni|onne|bags?|pcs?|pieces?|qty|quantity|venum|vaenum)\b/.test(
          t,
        ) ||
        /\b(price|prices|kohomada|kohanada|kochchara|kochcara|kiyanna|evlo)\b/.test(
          t,
        )
      if (qtyCue || n <= 9) return n
    }
  }

  const explicit =
    t.match(/\b(?:qty|quantity|x)\s*[:=]?\s*(\d{1,2})\b/) ||
    t.match(/\b(\d{1,2})\s*(?:x|bags?|pcs?|pieces?)\b/) ||
    t.match(/\b(?:bags?|pcs?|pieces?)\s*[:=]?\s*(\d{1,2})\b/)
  if (explicit) {
    const n = Number(explicit[1])
    if (n >= 1 && n <= 50) return n
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
  const out: number[] = []

  for (const m of t.matchAll(/\b(\d{1,2})\s*k\b/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= 20) out.push(n)
  }
  if (out.length) return out

  for (const m of t.matchAll(
    /\b(?:qty|quantity|x)\s*[:=]?\s*(\d{1,2})\b/g,
  )) {
    const n = Number(m[1])
    if (n >= 1 && n <= 50) out.push(n)
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*(?:bags?|pcs?|pieces?)\b/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= 50) out.push(n)
  }

  const wordMap: Array<[RegExp, number]> = [
    [/\bdekak\b/g, 2],
    [/\bthunak\b/g, 3],
    [/\bhatarak\b/g, 4],
    [/\bpahak\b/g, 5],
  ]
  for (const [re, n] of wordMap) {
    const matches = t.match(re)
    if (matches) for (let i = 0; i < matches.length; i++) out.push(n)
  }

  return out
}

/**
 * Parse order/quotation quantity from Singlish / Tanglish / English.
 * "3k ganna" → 3 (pieces). Defaults to 1 when nothing is mentioned.
 */
export function extractQty(text: string): number {
  return extractExplicitQty(text) ?? 1
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
  const { data } = await db
    .from('messages')
    .select('content_text, ai_context_summary')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(100)

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
  const { data } = await db
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(limit)

  return ((data ?? []) as Array<{ content_text: string | null }>)
    .map((m) => (m.content_text || '').trim())
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
  const { data } = await db
    .from('messages')
    .select('content_text, ai_context_summary')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(limit)

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

function titleCaseColor(color: string): string {
  return color
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
