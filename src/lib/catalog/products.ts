/**
 * Ladies Bags admin quick-messages catalog
 * (products + custom from /admin → WhatsApp quick messages).
 */

export const DEFAULT_CATALOG_BASE = 'https://www.ladiesbags.lk'

export interface CatalogQuickMessage {
  id: string
  title: string
  text: string
  /** Agent-facing blurb — what this quick message includes. */
  description: string
  imageUrls: string[]
  jpegReady: boolean
  productId: string | null
  sortOrder: number
  badgeColor: string
}

export function catalogBaseUrl(): string {
  const raw =
    process.env.LADIESBAGS_CATALOG_URL ||
    process.env.NEXT_PUBLIC_LADIESBAGS_CATALOG_URL ||
    DEFAULT_CATALOG_BASE
  return raw.replace(/\/$/, '')
}

export function productQuickReplyTitle(name: string): string {
  const trimmed = name.trim() || 'Product'
  if (/details quick reply$/i.test(trimmed)) return trimmed
  if (/quick reply$/i.test(trimmed)) return trimmed
  return `${trimmed} Details Quick Reply`
}

export function customQuickReplyTitle(name: string): string {
  const trimmed = name.trim() || 'Quick reply'
  if (/quick reply$/i.test(trimmed)) return trimmed
  return `${trimmed} Quick Reply`
}

/** Stub title for WhatsAppBot — products + custom both end with Quick Reply. */
export function stubTitleForCatalogMessage(msg: CatalogQuickMessage): string {
  if (msg.productId) return productQuickReplyTitle(msg.title)
  return customQuickReplyTitle(msg.title)
}

export function isMetaFriendlyImageUrl(url: string): boolean {
  return /\.(jpe?g|png)(\?|$)/i.test(url)
}

function normalizeQuickMessage(raw: unknown): CatalogQuickMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const id = typeof m.id === 'string' ? m.id : ''
  const title = typeof m.title === 'string' ? m.title : ''
  if (!id || !title) return null
  const text = typeof m.text === 'string' ? m.text : ''
  const description = typeof m.description === 'string' ? m.description.trim() : ''
  const imageUrls = Array.isArray(m.imageUrls)
    ? m.imageUrls.filter((u): u is string => typeof u === 'string' && !!u.trim())
    : []
  const badgeColor =
    typeof m.badgeColor === 'string' && m.badgeColor.trim()
      ? m.badgeColor.trim()
      : '#00a884'
  const productId = typeof m.productId === 'string' ? m.productId : null
  const sortOrder = Number(m.sortOrder) || 0
  const jpegReady = m.jpegReady === true
  return {
    id,
    title,
    text,
    description,
    imageUrls,
    jpegReady,
    productId,
    sortOrder,
    badgeColor,
  }
}

export async function fetchCatalogQuickMessages(
  base = catalogBaseUrl(),
): Promise<CatalogQuickMessage[]> {
  const res = await fetch(`${base}/api/quick-messages`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Quick messages fetch failed (HTTP ${res.status})`)
  }
  const data = await res.json()
  const list: unknown[] = Array.isArray(data?.messages) ? data.messages : []
  const normalized: CatalogQuickMessage[] = []
  for (const item of list) {
    const msg = normalizeQuickMessage(item)
    if (msg) normalized.push(msg)
  }
  return normalized.sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function fetchCatalogQuickMessage(
  catalogMessageId: string,
  base = catalogBaseUrl(),
): Promise<CatalogQuickMessage | null> {
  const messages = await fetchCatalogQuickMessages(base)
  return messages.find((m) => m.id === catalogMessageId) ?? null
}

/** @deprecated Prefer fetchCatalogQuickMessages — kept for older product-only callers. */
export interface CatalogProduct {
  id: string
  name: string
  price: number
  colors: string[]
  images: string[]
  description?: string
}

export function resolveCatalogImageUrl(url: string, siteBase = catalogBaseUrl()): string {
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  const base = siteBase.replace(/\/$/, '')
  return base + (url.startsWith('/') ? url : `/${url}`)
}

export async function fetchCatalogProducts(base = catalogBaseUrl()): Promise<CatalogProduct[]> {
  const res = await fetch(`${base}/api/products`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Catalog fetch failed (HTTP ${res.status})`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('Catalog response was not a product list')
  return data
    .map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return null
      const p = raw as Record<string, unknown>
      const id = typeof p.id === 'string' ? p.id : ''
      const name = typeof p.name === 'string' ? p.name : ''
      if (!id || !name) return null
      return {
        id,
        name,
        price: Number(p.price) || 0,
        colors: Array.isArray(p.colors)
          ? p.colors.filter((c): c is string => typeof c === 'string' && !!c.trim())
          : [],
        images: Array.isArray(p.images)
          ? p.images.filter((u): u is string => typeof u === 'string' && !!u.trim())
          : [],
      } satisfies CatalogProduct
    })
    .filter((p): p is CatalogProduct => p != null)
}

export async function fetchCatalogProduct(
  productId: string,
  base = catalogBaseUrl(),
): Promise<CatalogProduct | null> {
  const products = await fetchCatalogProducts(base)
  return products.find((p) => p.id === productId) ?? null
}

function parsePriceFromQuickMessageText(text: string): number {
  const priceMatch = /බෑග් එකට\s*([\d,]+)/.exec(text || '')
  return priceMatch ? Number(priceMatch[1].replace(/,/g, '')) || 0 : 0
}

function parseColorsFromQuickMessageText(text: string): string[] {
  const colorsMatch = /Available colors\s*:\s*(.+)/i.exec(text || '')
  if (!colorsMatch) return []
  return colorsMatch[1]
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
}

/**
 * Products for Create Order / Quotation pickers.
 * Prefer quick-message `imageUrls` (same order as colors, as in admin/TM),
 * and enrich price/colors/name from `/api/products` when `productId` matches.
 */
export async function fetchOrderPickerProducts(
  base = catalogBaseUrl(),
): Promise<CatalogProduct[]> {
  const [messages, products] = await Promise.all([
    fetchCatalogQuickMessages(base),
    fetchCatalogProducts(base).catch(() => [] as CatalogProduct[]),
  ])

  const byProductId = new Map(products.map((p) => [p.id, p]))
  const fromQuickReplies: CatalogProduct[] = []

  for (const msg of messages) {
    if (!msg.productId) continue
    const product = byProductId.get(msg.productId)
    const images = (msg.imageUrls.length ? msg.imageUrls : product?.images || [])
      .map((u) => resolveCatalogImageUrl(u, base))
      .filter(Boolean)

    const colors =
      product?.colors?.length
        ? product.colors
        : parseColorsFromQuickMessageText(msg.text)
    const price =
      product && product.price > 0
        ? product.price
        : parsePriceFromQuickMessageText(msg.text)
    const name = (product?.name || msg.title).trim()
    if (!name) continue

    fromQuickReplies.push({
      id: msg.productId,
      name,
      price,
      colors,
      images,
      description: msg.description || undefined,
    })
  }

  if (fromQuickReplies.length) return fromQuickReplies

  // Fallback when no product quick replies exist yet.
  return products.map((p) => ({
    ...p,
    images: p.images.map((u) => resolveCatalogImageUrl(u, base)).filter(Boolean),
  }))
}
