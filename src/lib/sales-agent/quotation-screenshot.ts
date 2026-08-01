import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import {
  formatLkr,
  QUOTATION_SHIPPING_LKR,
  type OrderLineItem,
} from '@/lib/orders/constants'
import {
  loadProductQuickReplies,
  matchProductByIdentifyName,
  matchProductsInText,
} from './match-products'
import { CONTEXT_BLURBS } from './types'
import {
  sendGeneratedCardImage,
  type CardMediaDebug,
} from './send-card-media'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Resolve missing price / image / productId from the catalog. */
export async function enrichQuotationLineItems(
  db: SupabaseClient,
  accountId: string,
  items: OrderLineItem[],
): Promise<OrderLineItem[]> {
  const catalog = await loadProductQuickReplies(db, accountId)
  const out: OrderLineItem[] = []

  for (const it of items) {
    let price = Number(it.price) || 0
    let image = it.image
    let productId = it.productId
    let name = it.name

    if ((!price || !image || !productId) && name) {
      const byName =
        matchProductByIdentifyName(name, catalog) ||
        matchProductsInText(name, catalog)[0] ||
        null
      if (byName?.product_id) {
        productId = productId || byName.product_id
        try {
          const p = await fetchCatalogProduct(byName.product_id)
          if (p) {
            name = p.name || name
            if (!price) price = Number(p.price) || 0
            if (!image) {
              image = catalogImageForColor(
                p,
                it.color || p.colors[0] || '',
              )
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    out.push({
      productId,
      name,
      color: it.color || '',
      qty: Math.max(1, Number(it.qty) || 1),
      price,
      image,
    })
  }
  return out
}

async function loadThumbBuffer(url: string | undefined): Promise<Buffer | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 32) return null
    return sharp(buf)
      .resize(112, 112, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toBuffer()
  } catch {
    return null
  }
}

/**
 * Render a QuotationCard-like JPEG (same layout as inbox Create Quotation).
 */
export async function renderQuotationCardPng(
  items: OrderLineItem[],
): Promise<Buffer> {
  const rowH = 72
  const headerH = 40
  const footerH = 72
  const pad = 12
  const height = pad + headerH + items.length * (rowH + 8) + footerH + pad
  const width = 360
  const font = 'DejaVu Sans, Arial, sans-serif'

  const itemsSubtotal = items.reduce(
    (sum, it) =>
      sum + (Number(it.price) || 0) * Math.max(1, Number(it.qty) || 1),
    0,
  )
  const grand = itemsSubtotal + QUOTATION_SHIPPING_LKR

  let y = pad + 22
  const parts: string[] = []
  const thumbSlots: Array<{ x: number; y: number; index: number }> = []

  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${font}" font-size="15" font-weight="700" fill="#e9edef">Price Quotation</text>`,
  )
  y += 18

  items.forEach((item, idx) => {
    const qty = Math.max(1, Number(item.qty) || 1)
    const price = Number(item.price) || 0
    const line = qty * price
    const top = y
    parts.push(
      `<rect x="12" y="${top}" width="336" height="${rowH}" rx="8" fill="#111b21" stroke="#2a3942"/>`,
      `<rect x="20" y="${top + 8}" width="56" height="56" rx="6" fill="#0b141a"/>`,
    )
    thumbSlots.push({ x: 20, y: top + 8, index: idx })

    const label = `${item.name}${item.color ? ` (${item.color})` : ''}`
    parts.push(
      `<text x="88" y="${top + 28}" font-family="${font}" font-size="13" font-weight="600" fill="#e9edef">${esc(label.slice(0, 42))}</text>`,
      `<text x="88" y="${top + 48}" font-family="${font}" font-size="11" fill="#8696a0">Qty ${qty} x ${esc(formatLkr(price))}</text>`,
      `<text x="336" y="${top + 40}" text-anchor="end" font-family="${font}" font-size="13" font-weight="700" fill="#e9edef">${esc(formatLkr(line))}</text>`,
    )
    y += rowH + 8
  })

  y += 4
  parts.push(
    `<line x1="12" y1="${y}" x2="348" y2="${y}" stroke="#2a3942" stroke-width="1"/>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="${font}" font-size="12" fill="#cfd7db">Items</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="${font}" font-size="12" fill="#cfd7db">${esc(formatLkr(itemsSubtotal))}</text>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="${font}" font-size="12" fill="#cfd7db">Shipping</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="${font}" font-size="12" fill="#cfd7db">${esc(formatLkr(QUOTATION_SHIPPING_LKR))}</text>`,
  )
  y += 22
  parts.push(
    `<text x="16" y="${y}" font-family="${font}" font-size="15" font-weight="700" fill="#e9edef">Total</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="${font}" font-size="15" font-weight="700" fill="#e9edef">${esc(formatLkr(grand))}</text>`,
  )

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" rx="8" fill="#182229"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="none" stroke="#2a3942"/>
  ${parts.join('\n  ')}
</svg>`

  let base = await sharp(Buffer.from(svg)).png().toBuffer()
  if (base.byteLength < 500) {
    throw new Error('Quotation card render produced empty image')
  }

  const composites: Array<{ input: Buffer; left: number; top: number }> = []
  for (const slot of thumbSlots) {
    const thumb = await loadThumbBuffer(items[slot.index]?.image)
    if (!thumb) continue
    composites.push({
      input: thumb,
      left: slot.x,
      top: Math.round(slot.y),
    })
  }

  if (composites.length) {
    base = await sharp(base).composite(composites).png().toBuffer()
  }

  const jpeg = await sharp(base).jpeg({ quality: 88, mozjpeg: true }).toBuffer()
  if (jpeg.byteLength < 500) {
    throw new Error('Quotation JPEG encode produced empty image')
  }
  return jpeg
}

export async function sendQuotationScreenshot(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  items: OrderLineItem[]
  caption?: string
}): Promise<CardMediaDebug> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    caption,
  } = args

  const items = await enrichQuotationLineItems(db, accountId, args.items)
  if (!items.length) throw new Error('No quotation items')

  const jpeg = await renderQuotationCardPng(items)
  const debug = await sendGeneratedCardImage({
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    bytes: jpeg,
    filename: `quotation-${Date.now()}.jpg`,
    mimeType: 'image/jpeg',
    caption,
    contextSummary: CONTEXT_BLURBS.quotation,
  })

  console.info('[sales-agent] quotation screenshot sent', debug)
  return debug
}
