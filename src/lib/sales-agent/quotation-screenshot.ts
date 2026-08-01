import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import {
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
import {
  CARD_BORDER,
  CARD_W,
  BODY,
  FG,
  FONT,
  MUTED,
  ROW_BG,
  THUMB_BG,
  cardShell,
  encodeCardJpeg,
  esc,
  formatQuotationMoneyTm,
  loadThumbBuffer,
  wrapLines,
} from './card-screenshot-shared'

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

    if (!price || !image || !productId) {
      if (!productId && name) {
        const byName =
          matchProductByIdentifyName(name, catalog) ||
          matchProductsInText(name, catalog)[0] ||
          null
        productId = byName?.product_id || productId
      }
      if (productId) {
        try {
          const p = await fetchCatalogProduct(productId)
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

/**
 * Render QuotationCard matching Tampermonkey `renderQuotationCard`
 * (#qm-quotation-card): title, item rows with thumbs, Items/Shipping/Total.
 * Money format matches script: `Rs 1,234`.
 */
export async function renderQuotationCardPng(
  items: OrderLineItem[],
): Promise<Buffer> {
  const pad = 12
  const headerH = 36
  const rowH = 72
  const thumbSize = 56
  const footerPad = 78
  const width = CARD_W
  const height =
    pad + headerH + items.length * (rowH + 8) + footerPad + pad

  const itemsSubtotal = items.reduce(
    (sum, it) =>
      sum + (Number(it.price) || 0) * Math.max(1, Number(it.qty) || 1),
    0,
  )
  const grand = itemsSubtotal + QUOTATION_SHIPPING_LKR

  let y = pad + 20
  const parts: string[] = []
  const thumbSlots: Array<{ x: number; y: number; index: number }> = []

  // Head — Tampermonkey uses emoji; Sharp-safe title without emoji
  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="${FG}">Price Quotation</text>`,
  )
  y = pad + headerH

  items.forEach((item, idx) => {
    const qty = Math.max(1, Number(item.qty) || 1)
    const price = Number(item.price) || 0
    const line = qty * price
    const top = y
    const label = `${item.name}${item.color ? ` (${item.color})` : ''}`
    const nameLines = wrapLines(label, 28, 2)

    parts.push(
      `<rect x="12" y="${top}" width="336" height="${rowH}" rx="8" fill="${ROW_BG}" stroke="${CARD_BORDER}"/>`,
      `<rect x="20" y="${top + 8}" width="${thumbSize}" height="${thumbSize}" rx="6" fill="${THUMB_BG}"/>`,
      `<text x="48" y="${top + 40}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#54656f">—</text>`,
    )
    thumbSlots.push({ x: 20, y: top + 8, index: idx })

    let ty = top + 24
    for (const nl of nameLines) {
      parts.push(
        `<text x="88" y="${ty}" font-family="${FONT}" font-size="12" font-weight="600" fill="${FG}">${esc(nl)}</text>`,
      )
      ty += 15
    }
    parts.push(
      `<text x="88" y="${top + 58}" font-family="${FONT}" font-size="11" fill="${MUTED}">Qty ${qty} x ${esc(formatQuotationMoneyTm(price))}</text>`,
      `<text x="336" y="${top + 40}" text-anchor="end" font-family="${FONT}" font-size="13" font-weight="700" fill="${FG}">${esc(formatQuotationMoneyTm(line))}</text>`,
    )
    y += rowH + 8
  })

  // Totals — Items, Shipping (400), Total with dashed separator like .qm-quot-grand
  y += 2
  parts.push(
    `<line x1="12" y1="${y}" x2="348" y2="${y}" stroke="${CARD_BORDER}" stroke-width="1"/>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="12" fill="${BODY}">Items</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${BODY}">${esc(formatQuotationMoneyTm(itemsSubtotal))}</text>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="12" fill="${BODY}">Shipping</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="${FONT}" font-size="12" fill="${BODY}">${esc(formatQuotationMoneyTm(QUOTATION_SHIPPING_LKR))}</text>`,
  )
  y += 10
  parts.push(
    `<line x1="12" y1="${y}" x2="348" y2="${y}" stroke="#3a4a52" stroke-width="1" stroke-dasharray="4 3"/>`,
  )
  y += 20
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="15" font-weight="700" fill="${FG}">Total</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="${FONT}" font-size="15" font-weight="700" fill="${FG}">${esc(formatQuotationMoneyTm(grand))}</text>`,
  )

  const svg = cardShell(height, parts.join('\n  '))

  const composites: Array<{ input: Buffer; left: number; top: number }> = []
  for (const slot of thumbSlots) {
    const thumb = await loadThumbBuffer(items[slot.index]?.image, thumbSize)
    if (!thumb) continue
    composites.push({
      input: thumb,
      left: slot.x,
      top: Math.round(slot.y),
    })
  }

  return encodeCardJpeg(svg, composites)
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

  console.info('[sales-agent] quotation screenshot sent', {
    ...debug,
    items: items.map((i) => ({
      name: i.name,
      color: i.color,
      qty: i.qty,
      price: i.price,
      hasImage: Boolean(i.image),
    })),
  })
  return debug
}
