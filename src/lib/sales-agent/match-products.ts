import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeMatchText } from './normalize'

export interface MatchableQuickReply {
  id: string
  title: string
  description: string | null
  kind: string
  product_id: string | null
  catalog_message_id: string | null
  /** Derived search needles (normalized). */
  needles: string[]
}

const TITLE_NOISE =
  /\b(details?\s+)?quick\s*reply\b|\bdetails\b/gi

function productNameFromTitle(title: string): string {
  return title.replace(TITLE_NOISE, '').replace(/\s+/g, ' ').trim()
}

/**
 * Build searchable needles for a product/catalog quick reply.
 */
export function buildProductNeedles(
  title: string,
  productId?: string | null,
  aliases?: string[],
): string[] {
  const name = productNameFromTitle(title)
  const needles = new Set<string>()
  const n = normalizeMatchText(name)
  if (n) {
    needles.add(n)
    // Without trailing "bag"
    needles.add(n.replace(/\bbags?\b/g, '').replace(/\s+/g, ' ').trim())
    // Individual significant tokens for multi-word names (≥4 chars)
    for (const tok of n.split(' ')) {
      if (tok.length >= 4 && tok !== 'bag' && tok !== 'bags') needles.add(tok)
    }
  }
  if (productId) {
    const pid = normalizeMatchText(productId.replace(/[_-]+/g, ' '))
    if (pid) needles.add(pid)
  }
  for (const a of aliases ?? []) {
    const na = normalizeMatchText(a)
    if (na) needles.add(na)
  }
  return [...needles].filter(Boolean).sort((a, b) => b.length - a.length)
}

export async function loadProductQuickReplies(
  db: SupabaseClient,
  accountId: string,
): Promise<MatchableQuickReply[]> {
  const { data, error } = await db
    .from('quick_replies')
    .select(
      'id, title, description, kind, product_id, catalog_message_id',
    )
    .eq('account_id', accountId)
    .in('kind', ['product', 'catalog'])
    .not('catalog_message_id', 'is', null)

  if (error) throw error

  return ((data ?? []) as Omit<MatchableQuickReply, 'needles'>[])
    .filter((r) => r.catalog_message_id || r.product_id)
    .map((r) => ({
      ...r,
      needles: buildProductNeedles(r.title, r.product_id),
    }))
}

/**
 * Find all product quick replies whose name appears in the customer text.
 * Longer needle wins when overlapping; returns unique QRs.
 */
export function matchProductsInText(
  text: string,
  catalog: MatchableQuickReply[],
): MatchableQuickReply[] {
  const hay = normalizeMatchText(text)
  if (!hay || hay.length < 2) return []

  const hits: { qr: MatchableQuickReply; score: number }[] = []

  for (const qr of catalog) {
    // Only match product-backed QRs here (custom catalog msgs handled elsewhere)
    const isProduct =
      Boolean(qr.product_id) ||
      (qr.catalog_message_id?.includes('prod') ?? false)
    if (!isProduct && qr.kind === 'catalog' && !qr.product_id) continue

    let best = 0
    for (const needle of qr.needles) {
      if (needle.length < 3) continue
      if (hay.includes(needle) || tokenBoundaryMatch(hay, needle)) {
        best = Math.max(best, needle.length)
      }
    }
    if (best > 0) hits.push({ qr, score: best })
  }

  hits.sort((a, b) => b.score - a.score)

  const seen = new Set<string>()
  const out: MatchableQuickReply[] = []
  for (const h of hits) {
    const key = h.qr.catalog_message_id || h.qr.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h.qr)
  }
  return out
}

function tokenBoundaryMatch(hay: string, needle: string): boolean {
  // Allow "bunny" to match "bunny bag" when needle is a single token
  if (!needle.includes(' ')) {
    const re = new RegExp(`(?:^|\\s)${escapeReg(needle)}(?:s)?(?:\\s|$)`)
    return re.test(hay)
  }
  return false
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve a product name from identify API to a catalog quick reply.
 */
export function matchProductByIdentifyName(
  productName: string,
  catalog: MatchableQuickReply[],
): MatchableQuickReply | null {
  const hits = matchProductsInText(productName, catalog)
  return hits[0] ?? null
}
