import type { SupabaseClient } from '@supabase/supabase-js'
import {
  formatOrderLabelBarcode,
  ORDER_STATUS_LABELS,
  orderShippingShortLabel,
  buildOrderScreenshotCaption,
} from '@/lib/orders/constants'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import { catalogBaseUrl, fetchCatalogProduct } from '@/lib/catalog/products'
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
  formatOrderMoneyTm,
  loadThumbBuffer,
  wrapLines,
} from './card-screenshot-shared'
import {
  loadProductQuickReplies,
  matchProductByIdentifyName,
  matchProductsInText,
} from './match-products'

type OrderLike = Record<string, unknown>

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

type EnrichedItem = {
  name: string
  color: string
  quantity: number
  price: number
  image?: string
}

/** Fill missing price/image from catalog — same idea as Tampermonkey resolveOrderItemImage. */
export async function enrichOrderItemsForScreenshot(
  db: SupabaseClient,
  accountId: string,
  items: OrderLike[],
): Promise<EnrichedItem[]> {
  const catalog = await loadProductQuickReplies(db, accountId)
  const out: EnrichedItem[] = []

  for (const it of items) {
    let name = String(it.name || 'Item')
    let color = String(it.color || '')
    let price = num(it.price)
    let image =
      typeof it.image === 'string' && it.image ? String(it.image) : undefined
    const productId =
      (typeof it.productId === 'string' && it.productId) ||
      (typeof it.product_id === 'string' && it.product_id) ||
      undefined

    if (!price || !image) {
      let pid = productId
      if (!pid && name) {
        const byName =
          matchProductByIdentifyName(name, catalog) ||
          matchProductsInText(name, catalog)[0] ||
          null
        pid = byName?.product_id || undefined
      }
      if (pid) {
        try {
          const p = await fetchCatalogProduct(pid)
          if (p) {
            name = p.name || name
            if (!price) price = Number(p.price) || 0
            if (!image) {
              image = catalogImageForColor(p, color || p.colors[0] || '')
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    out.push({
      name,
      color,
      quantity: Math.max(1, num(it.quantity ?? it.qty)),
      price,
      image,
    })
  }
  return out
}

/**
 * Render OrderCard matching Tampermonkey `renderOrderCardHtml` / inbox OrderCard.
 */
export async function renderOrderCardJpeg(
  order: OrderLike,
  opts?: { enrichedItems?: EnrichedItem[] },
): Promise<Buffer> {
  const rawItems = Array.isArray(order.items) ? (order.items as OrderLike[]) : []
  const items =
    opts?.enrichedItems ||
    rawItems.map((it) => ({
      name: String(it.name || 'Item'),
      color: String(it.color || ''),
      quantity: Math.max(1, num(it.quantity ?? it.qty)),
      price: num(it.price),
      image:
        typeof it.image === 'string' && it.image ? String(it.image) : undefined,
    }))

  const itemsTotal = items.reduce((sum, it) => sum + it.price * it.quantity, 0)
  const courierCharge = num(order.courier_charge ?? order.shipping_cost)
  const totalAmount = num(order.total_amount) || itemsTotal + courierCharge
  const amountPaid = num(order.amount_paid)
  const remaining = Math.max(0, totalAmount - amountPaid)
  const showPayment =
    order.order_status === 'half_payment' ||
    order.order_status === 'full_payment' ||
    amountPaid > 0
  const statusLabel =
    ORDER_STATUS_LABELS[String(order.order_status || '')] ||
    String(order.order_status || '').replace(/_/g, ' ') ||
    'ChatBot'
  const shipLabel = orderShippingShortLabel(
    typeof order.shipping_method === 'string' ? order.shipping_method : null,
  )
  const saleLabel = order.sale_type === 'wholesale' ? 'Wholesale' : 'Retail'
  const labelId = formatOrderLabelBarcode(
    typeof order.id === 'string' ? order.id : null,
  )
  const created = order.created_at
    ? new Date(String(order.created_at)).toLocaleString()
    : ''
  const fullName = String(order.full_name || order.customer_name || '—')
  const address = String(order.address || '')
  const mobile1 = String(order.mobile_1 || order.phone || '')
  const mobile2 = String(order.mobile_2 || order.phone2 || '')
  const waChat = String(order.whatsapp_phone || '')
  const city = String(order.city || '')
  const tracking = String(order.tracking_number || '')

  const addressLines = address
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const pad = 8
  const rowH = 72
  const thumbSize = 56
  let y = pad + 14
  const parts: string[] = []
  const thumbSlots: Array<{ x: number; y: number; index: number }> = []

  // Header: label + created
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="11" fill="${MUTED}">${esc(labelId)}</text>`,
  )
  y += 16
  if (created) {
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="11" fill="${MUTED}">${esc(created)}</text>`,
    )
    y += 18
  }

  // Badges (status / sale / ship) — pill rows like Tampermonkey
  const badges = [
    { label: statusLabel, bg: '#334155', fg: FG },
    { label: saleLabel, bg: CARD_BORDER, fg: FG },
    { label: shipLabel, bg: '#422006', fg: '#fcd34d' },
  ]
  let bx = 16
  const badgeY = y
  for (const b of badges) {
    const tw = Math.min(140, 10 + b.label.length * 6.2)
    parts.push(
      `<rect x="${bx}" y="${badgeY}" width="${tw}" height="18" rx="9" fill="${b.bg}"/>`,
      `<text x="${bx + tw / 2}" y="${badgeY + 13}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${b.fg}">${esc(b.label)}</text>`,
    )
    bx += tw + 6
  }
  y += 28

  // Customer
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="11" fill="${MUTED}" letter-spacing="0.5">CUSTOMER</text>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="14" font-weight="700" fill="${FG}">${esc(fullName)}</text>`,
  )
  y += 18
  addressLines.forEach((line, i) => {
    const prefix = i === 0 ? 'Loc: ' : ''
    for (const wl of wrapLines(prefix + line, 46, 2)) {
      parts.push(
        `<text x="16" y="${y}" font-family="${FONT}" font-size="13" fill="${BODY}">${esc(wl)}</text>`,
      )
      y += 17
    }
  })
  if (mobile1) {
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="13" fill="${BODY}">Tel: ${esc(mobile1)}</text>`,
    )
    y += 17
  }
  if (mobile2) {
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="13" fill="${BODY}">Tel: ${esc(mobile2)}</text>`,
    )
    y += 17
  }
  if (waChat && waChat !== mobile1) {
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="13" fill="${MUTED}">WA: ${esc(waChat)}</text>`,
    )
    y += 17
  }
  if (city) {
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="13" fill="${BODY}">City: ${esc(city)}</text>`,
    )
    y += 17
  }

  y += 8
  parts.push(
    `<text x="16" y="${y}" font-family="${FONT}" font-size="11" fill="${MUTED}" letter-spacing="0.5">ITEMS</text>`,
  )
  y += 10

  if (!items.length) {
    y += 16
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="12" fill="${MUTED}">No items</text>`,
    )
    y += 20
  } else {
    items.forEach((it, idx) => {
      const top = y
      const lineTotal = it.price * it.quantity
      const label = `${it.name}${it.color ? ` (${it.color})` : ''}`
      const nameLines = wrapLines(label, 28, 2)

      parts.push(
        `<rect x="8" y="${top}" width="344" height="${rowH}" rx="8" fill="${ROW_BG}" stroke="${CARD_BORDER}"/>`,
        `<rect x="16" y="${top + 8}" width="${thumbSize}" height="${thumbSize}" rx="6" fill="${THUMB_BG}"/>`,
        `<text x="44" y="${top + 40}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="#54656f">—</text>`,
      )
      thumbSlots.push({ x: 16, y: top + 8, index: idx })

      let ty = top + 24
      for (const nl of nameLines) {
        parts.push(
          `<text x="84" y="${ty}" font-family="${FONT}" font-size="12" font-weight="600" fill="${FG}">${esc(nl)}</text>`,
        )
        ty += 15
      }
      parts.push(
        `<text x="84" y="${top + 58}" font-family="${FONT}" font-size="11" fill="${MUTED}">Qty ${it.quantity} x ${esc(formatOrderMoneyTm(it.price))}</text>`,
        `<text x="340" y="${top + 40}" text-anchor="end" font-family="${FONT}" font-size="12" font-weight="700" fill="${FG}">${esc(formatOrderMoneyTm(lineTotal))}</text>`,
      )
      y += rowH + 8
    })
  }

  // Totals
  y += 4
  parts.push(
    `<line x1="8" y1="${y}" x2="352" y2="${y}" stroke="${CARD_BORDER}" stroke-width="1"/>`,
  )
  y += 18

  const moneyRow = (label: string, amount: number, strong = false) => {
    const fill = strong ? FG : MUTED
    const size = strong ? 13 : 12
    const weight = strong ? '700' : '400'
    parts.push(
      `<text x="16" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(label)}</text>`,
      `<text x="344" y="${y}" text-anchor="end" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(formatOrderMoneyTm(amount))}</text>`,
    )
    y += strong ? 20 : 17
  }

  moneyRow('Items', itemsTotal)
  moneyRow(shipLabel, courierCharge)
  if (showPayment) {
    moneyRow('Order total', totalAmount)
    moneyRow('Paid', amountPaid)
  }
  moneyRow('Total', showPayment ? remaining : totalAmount, true)

  if (tracking) {
    y += 4
    const tw = Math.min(120, 10 + shipLabel.length * 6.2)
    parts.push(
      `<rect x="16" y="${y - 12}" width="${tw}" height="16" rx="4" fill="#422006"/>`,
      `<text x="${16 + tw / 2}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#fcd34d">${esc(shipLabel)}</text>`,
      `<text x="${16 + tw + 8}" y="${y}" font-family="${FONT}" font-size="12" fill="${FG}">${esc(tracking)}</text>`,
    )
    y += 16
  }

  const height = Math.max(y + 16, 280)
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

/** @deprecated use renderOrderCardJpeg */
export async function renderOrderCardPng(order: OrderLike): Promise<Buffer> {
  return renderOrderCardJpeg(order)
}

/**
 * Send the same order-confirm image + caption used by inbox /
 * Tampermonkey "Send order screenshot after creating".
 */
export async function sendOrderConfirmScreenshot(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  order: OrderLike
}): Promise<CardMediaDebug> {
  const { db, accountId, conversationId, contactId, configOwnerUserId, order } =
    args

  const rawItems = Array.isArray(order.items) ? (order.items as OrderLike[]) : []
  const enrichedItems = await enrichOrderItemsForScreenshot(
    db,
    accountId,
    rawItems,
  )
  const orderForRender: OrderLike = { ...order, items: enrichedItems }

  const jpeg = await renderOrderCardJpeg(orderForRender, { enrichedItems })
  const itemsTotal = enrichedItems.reduce(
    (sum, it) => sum + it.price * it.quantity,
    0,
  )
  const captionTotal =
    num(order.total_amount) ||
    itemsTotal + num(order.courier_charge ?? order.shipping_cost)
  const caption = buildOrderScreenshotCaption(
    {
      id: typeof order.id === 'string' ? order.id : undefined,
      total_amount: captionTotal,
    },
    catalogBaseUrl(),
  )

  const debug = await sendGeneratedCardImage({
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    bytes: jpeg,
    filename: `order-${Date.now()}.jpg`,
    mimeType: 'image/jpeg',
    caption,
    contextSummary: CONTEXT_BLURBS.orderConfirm,
  })

  console.info('[sales-agent] order screenshot sent', {
    ...debug,
    items: enrichedItems.map((i) => ({
      name: i.name,
      color: i.color,
      qty: i.quantity,
      price: i.price,
      hasImage: Boolean(i.image),
    })),
  })
  return debug
}
