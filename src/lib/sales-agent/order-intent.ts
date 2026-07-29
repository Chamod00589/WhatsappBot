import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCatalogProduct } from '@/lib/catalog/products'
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

export interface OrderPendingState {
  type: 'awaiting_color'
  bags: Array<{
    productId: string | null
    catalogMessageId: string | null
    name: string
    qty: number
    quickReplyId: string
  }>
  addressText: string
  askedAt: string
}

export function parseOrderPending(raw: unknown): OrderPendingState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
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
    askedAt: typeof o.askedAt === 'string' ? o.askedAt : new Date().toISOString(),
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

export function extractQty(text: string): number {
  const t = text.toLowerCase()
  if (/\b(dekak|2|two)\b/.test(t)) return 2
  if (/\b(thunak|3|three)\b/.test(t)) return 3
  if (/\b(hatarak|4|four)\b/.test(t)) return 4
  return 1
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
  const qty = extractQty(merged)
  const out: BagOrderIntent[] = []

  for (const hit of hits) {
    const name = productDisplayName(hit.title)
    // Prefer color mentioned near this product in individual messages
    let color: string | null = null
    for (const text of texts) {
      const localHits = matchProductsInText(text, [hit])
      if (!localHits.length) continue
      const localColors = extractColorsFromText(text)
      if (localColors.length) {
        color = localColors[0]
        break
      }
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
      qty,
      quickReplyId: hit.id,
    })
  }
  return out
}

export async function resolveLineItems(
  intents: BagOrderIntent[],
): Promise<OrderLineItem[]> {
  const items: OrderLineItem[] = []
  for (const intent of intents) {
    let price = 0
    let name = intent.name
    if (intent.productId) {
      try {
        const p = await fetchCatalogProduct(intent.productId)
        if (p) {
          price = p.price || 0
          name = p.name || name
        }
      } catch {
        /* ignore */
      }
    }
    items.push({
      productId: intent.productId || undefined,
      name,
      color: intent.color || '',
      qty: intent.qty,
      price,
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
    return `${names} eka ganna color eka mokakda? (${colorHint})`
  }
  return `${names} ku ethu color venum? (${colorHint})`
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
