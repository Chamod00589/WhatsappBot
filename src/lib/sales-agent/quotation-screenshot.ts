import sharp from 'sharp'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  formatLkr,
  QUOTATION_SHIPPING_LKR,
  type OrderLineItem,
} from '@/lib/orders/constants'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { CONTEXT_BLURBS } from './types'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function thumbDataUri(url: string | undefined): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const small = await sharp(buf)
      .resize(112, 112, { fit: 'cover' })
      .png()
      .toBuffer()
    return `data:image/png;base64,${small.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * Render a QuotationCard-like PNG (same layout as inbox Create Quotation).
 */
export async function renderQuotationCardPng(
  items: OrderLineItem[],
): Promise<Buffer> {
  const thumbs = await Promise.all(items.map((it) => thumbDataUri(it.image)))

  const rowH = 72
  const headerH = 40
  const footerH = 72
  const pad = 12
  const height = pad + headerH + items.length * (rowH + 8) + footerH + pad
  const width = 360

  const itemsSubtotal = items.reduce(
    (sum, it) =>
      sum + (Number(it.price) || 0) * Math.max(1, Number(it.qty) || 1),
    0,
  )
  const grand = itemsSubtotal + QUOTATION_SHIPPING_LKR

  let y = pad + 22
  const parts: string[] = []

  parts.push(
    `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="15" font-weight="700" fill="#e9edef">Price Quotation</text>`,
  )
  y += 18

  items.forEach((item, idx) => {
    const qty = Math.max(1, Number(item.qty) || 1)
    const price = Number(item.price) || 0
    const line = qty * price
    const top = y
    parts.push(
      `<rect x="12" y="${top}" width="336" height="${rowH}" rx="8" fill="#111b21" stroke="#2a3942"/>`,
    )
    const thumb = thumbs[idx]
    if (thumb) {
      parts.push(
        `<image href="${thumb}" xlink:href="${thumb}" x="20" y="${top + 8}" width="56" height="56" preserveAspectRatio="xMidYMid slice"/>`,
      )
    } else {
      parts.push(
        `<rect x="20" y="${top + 8}" width="56" height="56" rx="6" fill="#0b141a"/>`,
        `<text x="48" y="${top + 40}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#54656f">—</text>`,
      )
    }
    const label = `${item.name}${item.color ? ` (${item.color})` : ''}`
    parts.push(
      `<text x="88" y="${top + 28}" font-family="sans-serif" font-size="13" font-weight="600" fill="#e9edef">${esc(label.slice(0, 42))}</text>`,
      `<text x="88" y="${top + 48}" font-family="sans-serif" font-size="11" fill="#8696a0">Qty ${qty} × ${esc(formatLkr(price))}</text>`,
      `<text x="336" y="${top + 40}" text-anchor="end" font-family="sans-serif" font-size="13" font-weight="700" fill="#e9edef">${esc(formatLkr(line))}</text>`,
    )
    y += rowH + 8
  })

  y += 4
  parts.push(
    `<line x1="12" y1="${y}" x2="348" y2="${y}" stroke="#2a3942" stroke-width="1"/>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="sans-serif" font-size="12" fill="#cfd7db">Items</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#cfd7db">${esc(formatLkr(itemsSubtotal))}</text>`,
  )
  y += 18
  parts.push(
    `<text x="16" y="${y}" font-family="sans-serif" font-size="12" fill="#cfd7db">Shipping</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#cfd7db">${esc(formatLkr(QUOTATION_SHIPPING_LKR))}</text>`,
  )
  y += 22
  parts.push(
    `<text x="16" y="${y}" font-family="sans-serif" font-size="15" font-weight="700" fill="#e9edef">Total</text>`,
    `<text x="344" y="${y}" text-anchor="end" font-family="sans-serif" font-size="15" font-weight="700" fill="#e9edef">${esc(formatLkr(grand))}</text>`,
  )

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <rect width="${width}" height="${height}" rx="8" fill="#182229"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="none" stroke="#2a3942"/>
  ${parts.join('\n  ')}
</svg>`

  return sharp(Buffer.from(svg)).png().toBuffer()
}

export async function sendQuotationScreenshot(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  items: OrderLineItem[]
  caption?: string
}): Promise<void> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    items,
    caption,
  } = args

  const png = await renderQuotationCardPng(items)
  const path = buildMediaPath(accountId, `quotation-${Date.now()}.png`)
  const { error } = await db.storage.from('chat-media').upload(path, png, {
    cacheControl: '3600',
    upsert: false,
    contentType: 'image/png',
  })
  if (error) throw new Error(`Quotation upload failed: ${error.message}`)

  const {
    data: { publicUrl },
  } = db.storage.from('chat-media').getPublicUrl(path)

  const sent = await engineSendMedia({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    kind: 'image',
    link: publicUrl,
    caption: caption?.slice(0, 1024),
    aiGenerated: true,
  })

  if (sent.message_id) {
    await db
      .from('messages')
      .update({ ai_context_summary: CONTEXT_BLURBS.quotation })
      .eq('id', sent.message_id)
  }
}
