import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  formatOrderLabelBarcode,
  formatOrderMoney,
  ORDER_STATUS_LABELS,
  orderShippingShortLabel,
  buildOrderScreenshotCaption,
} from '@/lib/orders/constants'
import { catalogBaseUrl } from '@/lib/catalog/products'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { CONTEXT_BLURBS } from './types'

type OrderLike = Record<string, unknown>

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render an OrderCard-like PNG (same dark WhatsApp-style card as inbox
 * Create Order screenshot) using sharp + SVG.
 */
export async function renderOrderCardPng(order: OrderLike): Promise<Buffer> {
  const items = Array.isArray(order.items) ? (order.items as OrderLike[]) : []
  const itemsTotal = items.reduce(
    (sum, it) => sum + num(it.price) * num(it.quantity),
    0,
  )
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
  const city = String(order.city || '')

  const addressLines = address
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  let y = 28
  const rows: string[] = []
  const push = (line: string, dy = 18) => {
    rows.push(line.replace(/\{\{Y\}\}/g, String(y)))
    y += dy
  }

  push(
    `<text x="16" y="{{Y}}" font-family="ui-monospace,monospace" font-size="11" fill="#8696a0">${esc(labelId)}</text>`,
    16,
  )
  if (created) {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="11" fill="#8696a0">${esc(created)}</text>`,
      16,
    )
  }
  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="11" fill="#e9edef">${esc(statusLabel)} · Retail · ${esc(shipLabel)}</text>`,
    26,
  )

  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="11" fill="#8696a0">CUSTOMER</text>`,
    18,
  )
  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="14" font-weight="700" fill="#e9edef">${esc(fullName)}</text>`,
    20,
  )
  // No emoji in SVG text — Sharp/librsvg often fails to rasterize them,
  // which made Meta send fail and fell back to text-only confirm.
  addressLines.forEach((line) => {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="13" fill="#cfd7db">${esc(line)}</text>`,
      18,
    )
  })
  if (mobile1) {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="13" fill="#cfd7db">${esc(mobile1)}</text>`,
      18,
    )
  }
  if (mobile2) {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="13" fill="#cfd7db">${esc(mobile2)}</text>`,
      18,
    )
  }
  if (city) {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="13" fill="#cfd7db">${esc(city)}</text>`,
      22,
    )
  }

  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="11" fill="#8696a0">ITEMS</text>`,
    20,
  )

  if (!items.length) {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="12" fill="#8696a0">No items</text>`,
      20,
    )
  } else {
    for (const it of items) {
      const qty = num(it.quantity)
      const price = num(it.price)
      const lineTotal = qty * price
      const name = String(it.name || 'Item')
      const color = it.color ? ` (${String(it.color)})` : ''
      push(
        `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="13" font-weight="600" fill="#e9edef">${esc(name + color)}</text>`,
        16,
      )
      push(
        `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="11" fill="#8696a0">Qty ${qty} × ${esc(formatOrderMoney(price))}   ${esc(formatOrderMoney(lineTotal))}</text>`,
        22,
      )
    }
  }

  y += 4
  push(
    `<line x1="16" y1="{{Y}}" x2="344" y2="{{Y}}" stroke="#2a3942" stroke-width="1"/>`,
    18,
  )
  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="12" fill="#8696a0">Items</text><text x="344" y="{{Y}}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#8696a0">${esc(formatOrderMoney(itemsTotal))}</text>`,
    18,
  )
  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="12" fill="#8696a0">${esc(shipLabel)}</text><text x="344" y="{{Y}}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#8696a0">${esc(formatOrderMoney(courierCharge))}</text>`,
    18,
  )
  if (showPayment) {
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="12" fill="#8696a0">Order total</text><text x="344" y="{{Y}}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#8696a0">${esc(formatOrderMoney(totalAmount))}</text>`,
      18,
    )
    push(
      `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="12" fill="#8696a0">Paid</text><text x="344" y="{{Y}}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#8696a0">${esc(formatOrderMoney(amountPaid))}</text>`,
      18,
    )
  }
  const totalShow = showPayment ? remaining : totalAmount
  push(
    `<text x="16" y="{{Y}}" font-family="sans-serif" font-size="14" font-weight="700" fill="#e9edef">Total</text><text x="344" y="{{Y}}" text-anchor="end" font-family="sans-serif" font-size="14" font-weight="700" fill="#e9edef">${esc(formatOrderMoney(totalShow))}</text>`,
    24,
  )

  const height = Math.max(y + 20, 280)
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="360" height="${height}" viewBox="0 0 360 ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="360" height="${height}" rx="8" fill="#182229"/>
  <rect x="0.5" y="0.5" width="359" height="${height - 1}" rx="8" fill="none" stroke="#2a3942"/>
  ${rows.join('\n  ')}
</svg>`

  return sharp(Buffer.from(svg)).png().toBuffer()
}

export async function uploadOrderScreenshotAdmin(
  db: SupabaseClient,
  accountId: string,
  png: Buffer,
): Promise<{ publicUrl: string; path: string }> {
  const path = buildMediaPath(accountId, `order-${Date.now()}.png`)
  const { error } = await db.storage.from('chat-media').upload(path, png, {
    cacheControl: '3600',
    upsert: false,
    contentType: 'image/png',
  })
  if (error) throw new Error(`Screenshot upload failed: ${error.message}`)
  const {
    data: { publicUrl },
  } = db.storage.from('chat-media').getPublicUrl(path)
  return { publicUrl, path }
}

/**
 * Send the same order-confirm image + caption used by inbox
 * "Send order screenshot after creating".
 */
export async function sendOrderConfirmScreenshot(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  order: OrderLike
}): Promise<void> {
  const { db, accountId, conversationId, contactId, configOwnerUserId, order } =
    args

  const png = await renderOrderCardPng(order)
  const { publicUrl } = await uploadOrderScreenshotAdmin(db, accountId, png)
  const items = Array.isArray(order.items) ? (order.items as OrderLike[]) : []
  const itemsTotal = items.reduce(
    (sum, it) => sum + num(it.price) * num(it.quantity),
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

  const sent = await engineSendMedia({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    kind: 'image',
    link: publicUrl,
    caption,
    aiGenerated: true,
  })

  if (sent.message_id) {
    await db
      .from('messages')
      .update({ ai_context_summary: CONTEXT_BLURBS.orderConfirm })
      .eq('id', sent.message_id)
  }
}
