import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchCatalogProducts,
  fetchCatalogQuickMessages,
  type CatalogProduct,
} from '@/lib/catalog/products'
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
  /** Curated aliases from ladiesbags product admin (raw strings). */
  matchAliases?: string[]
  /** From ladiesbags.lk admin products (retail catalog). */
  bagName?: string | null
  retailPrice?: number | null
  colors?: string[]
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
 * Attach bag name / retail price / colors / curated aliases from ladiesbags.lk
 * `/api/products` and `/api/quick-messages` (same source as admin products).
 */
export async function enrichProductsWithCatalogDetails(
  products: MatchableQuickReply[],
): Promise<MatchableQuickReply[]> {
  if (!products.length) return products
  let catalog: CatalogProduct[] = []
  let quickMsgs: Awaited<ReturnType<typeof fetchCatalogQuickMessages>> = []
  try {
    ;[catalog, quickMsgs] = await Promise.all([
      fetchCatalogProducts(),
      fetchCatalogQuickMessages(undefined, { lite: true }).catch(() => []),
    ])
  } catch (err) {
    console.warn(
      '[sales-agent] catalog products fetch failed — agent list without prices/colors:',
      err,
    )
    return products
  }
  if (!catalog.length && !quickMsgs.length) return products

  const byId = new Map(catalog.map((p) => [p.id, p]))
  const byName = new Map(
    catalog.map((p) => [normalizeMatchText(p.name), p] as const),
  )
  const aliasesByCatalogId = new Map(
    quickMsgs.map((m) => [m.id, m.matchAliases ?? []] as const),
  )
  const aliasesByProductId = new Map(
    quickMsgs
      .filter((m) => m.productId)
      .map((m) => [m.productId as string, m.matchAliases ?? []] as const),
  )

  return products.map((qr) => {
    const fromId = qr.product_id ? byId.get(qr.product_id) : undefined
    const titleName = productNameFromTitle(qr.title)
    const fromName =
      fromId ||
      byName.get(normalizeMatchText(titleName)) ||
      catalog.find((p) => {
        const pn = normalizeMatchText(p.name)
        const tn = normalizeMatchText(titleName)
        return pn.includes(tn) || tn.includes(pn)
      })

    const exportAliases =
      (qr.catalog_message_id
        ? aliasesByCatalogId.get(qr.catalog_message_id)
        : undefined) ||
      (qr.product_id ? aliasesByProductId.get(qr.product_id) : undefined) ||
      []
    const curated = [
      ...exportAliases,
      ...(fromName?.aliases ?? []),
      ...(qr.matchAliases ?? []),
    ]

    if (!fromName) {
      return {
        ...qr,
        bagName: titleName || qr.title,
        matchAliases: curated.length ? curated : qr.matchAliases,
        needles: buildProductNeedles(qr.title, qr.product_id, curated),
      }
    }
    return {
      ...qr,
      bagName: fromName.name,
      retailPrice: fromName.price,
      colors: fromName.colors,
      matchAliases: curated,
      needles: buildProductNeedles(fromName.name, fromName.id, curated),
    }
  })
}

/** One-line catalog blurb for the Sales Agent system prompt. */
export function formatProductCatalogLine(q: MatchableQuickReply): string {
  const name =
    (q.bagName || productNameFromTitle(q.title) || q.title).trim() || q.title
  const price =
    typeof q.retailPrice === 'number' && q.retailPrice > 0
      ? `Rs ${q.retailPrice.toLocaleString('en-US')}`
      : 'price unknown'
  const colors =
    q.colors && q.colors.length
      ? q.colors.join(', ')
      : 'colors unknown'
  return (
    `- ${name} | retail=${price} | colors=${colors}` +
    ` | id=${q.id}` +
    (q.product_id ? ` | product=${q.product_id}` : '') +
    (q.catalog_message_id ? ` | catalog=${q.catalog_message_id}` : '')
  )
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
