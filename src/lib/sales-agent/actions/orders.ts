import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { engineSendText } from '@/lib/flows/meta-send'
import {
  createOrderOnLadiesbags,
  fetchOrderByPhone,
  ladiesbagsOrdersRequest,
  updateOrderOnLadiesbags,
} from '@/lib/orders/ladiesbags-orders'
import {
  buildOrderTextWithProducts,
  geminiAddressPrompt,
  QUOTATION_SHIPPING_LKR,
  formatLkr,
  type OrderLineItem,
} from '@/lib/orders/constants'
import {
  buildCustomerTrackingText,
  publicCustomerTrackingUrl,
  type TrackingStatusPayload,
} from '@/lib/orders/customer-tracking-message'
import { formatOrderLabelBarcode } from '@/lib/orders/constants'
import { catalogBaseUrl } from '@/lib/catalog/products'
import { sendOrderConfirmScreenshot } from '../order-screenshot'
import {
  enrichQuotationLineItems,
  sendQuotationScreenshot,
} from '../quotation-screenshot'
import { addNamedTag } from '../tags'
import { CONTEXT_BLURBS } from '../types'

async function stampSummary(
  db: SupabaseClient,
  conversationId: string,
  summary: string,
) {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (data?.id) {
    await db
      .from('messages')
      .update({ ai_context_summary: summary })
      .eq('id', data.id)
  }
}

export async function extractAddressBlock(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  text: string,
): Promise<string> {
  const config = await loadAiConfig(db, accountId, { requireActive: false })
  if (!config) throw new Error('AI not configured for address extract')

  const { text: reply, usage } = await generateReply({
    config,
    systemPrompt:
      'You extract customer delivery details for Sri Lankan shipping labels. Follow the user instructions exactly. Output only the requested @@ format — no markdown, no commentary, no blank lines.',
    messages: [{ role: 'user', content: geminiAddressPrompt(text) }],
  })
  void logAiUsage(db, {
    accountId,
    conversationId,
    mode: 'auto_reply',
    provider: config.provider,
    model: config.model,
    usage,
  })
  const out = reply.trim()
  if (!out) throw new Error('Address extract returned empty')
  return out
}

export async function actionCreateOrder(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  addressText: string
  items: OrderLineItem[]
  contactPhone?: string | null
  useSinglish: boolean
}): Promise<{ ok: boolean; message: string }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    addressText,
    items,
    contactPhone,
    useSinglish,
  } = args

  if (!items.length) {
    return { ok: false, message: 'No products selected for the order' }
  }

  const addressBlock = await extractAddressBlock(
    db,
    accountId,
    conversationId,
    addressText,
  )
  const orderText = buildOrderTextWithProducts(addressBlock, items)

  const result = (await createOrderOnLadiesbags({
    text: orderText,
    whatsapp_phone: contactPhone || undefined,
    payment_status: 'pending',
    order_status: 'chatbot',
  })) as { order?: Record<string, unknown>; success?: boolean }

  let order = (result?.order ?? result) as Record<string, unknown>
  if (!order || typeof order !== 'object') {
    return { ok: false, message: 'Order create returned no order' }
  }

  // Prefer fresh full order (items, totals, courier) — same as inbox Create Order screenshot path.
  const lookupPhone =
    contactPhone ||
    (typeof order.mobile_1 === 'string' ? order.mobile_1 : null) ||
    (typeof order.whatsapp_phone === 'string' ? order.whatsapp_phone : null)
  if (lookupPhone) {
    try {
      const fresh = (await fetchOrderByPhone({
        phone: lookupPhone,
        days: 3,
        whatsappOnly: false,
      })) as { order?: Record<string, unknown> }
      if (fresh?.order && typeof fresh.order === 'object') {
        order = fresh.order
      }
    } catch (err) {
      console.warn('[sales-agent] post-create order refetch failed:', err)
    }
  }

  // Merge line items we know about if API returned empty items / zero total
  if ((!Array.isArray(order.items) || order.items.length === 0) && items.length) {
    order = {
      ...order,
      items: items.map((it) => ({
        name: it.name,
        color: it.color,
        quantity: it.qty,
        price: it.price,
        productId: it.productId,
        image: it.image,
      })),
    }
  }
  const itemsTotal = items.reduce((s, it) => s + it.price * it.qty, 0)
  if (!numSafe(order.total_amount) && itemsTotal > 0) {
    const courier = numSafe(order.courier_charge) || 400
    order = {
      ...order,
      courier_charge: order.courier_charge ?? courier,
      total_amount: itemsTotal + courier,
    }
  }

  try {
    const shot = await sendOrderConfirmScreenshot({
      db,
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
      order,
    })
    await addNamedTag(db, accountId, contactId, 'Pending')
    return {
      ok: true,
      message: `Order created ${formatOrderLabelBarcode(String(order.id || ''))}; screenshot ${shot.sendMode} ${Math.round(shot.bytes / 1024)}kb meta=${shot.metaMediaId || 'none'} url=${shot.publicUrl}`,
    }
  } catch (err) {
    console.error('[sales-agent] order screenshot send failed:', err)
    const errMsg = err instanceof Error ? err.message : String(err)
    // Fallback: short Singlish/Tanglish text so customer still gets a confirm ask
    const trackId = formatOrderLabelBarcode(String(order.id || ''))
    const total = Math.round(numSafe(order.total_amount) || itemsTotal)
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: useSinglish
        ? `Order create una (total Rs ${total}/-). Details hari neda (bag color + address)? "ok" kiyanna.\nTracking: ${catalogBaseUrl().replace(/\/$/, '')}/tracking/${trackId}`
        : `Order create aachu (total Rs ${total}/-). Details correct-a (bag color + address)? "ok" anupunga.\nTracking: ${catalogBaseUrl().replace(/\/$/, '')}/tracking/${trackId}`,
      aiGenerated: true,
    })
    await stampSummary(db, conversationId, CONTEXT_BLURBS.orderConfirm)
    await addNamedTag(db, accountId, contactId, 'Pending')
    return {
      ok: true,
      message: `Order created ${formatOrderLabelBarcode(String(order.id || ''))}; screenshot FAILED (${errMsg}) — sent text fallback`,
    }
  }
}

function numSafe(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function actionSendTracking(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string
}): Promise<{ ok: boolean; message: string }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    contactPhone,
  } = args

  const raw = (await fetchOrderByPhone({
    phone: contactPhone,
    days: 90,
    whatsappOnly: true,
  })) as { order?: Record<string, unknown>; orders?: Record<string, unknown>[] }

  const order =
    raw?.order ||
    (Array.isArray(raw?.orders) ? raw.orders[0] : null) ||
    (raw && typeof raw === 'object' && 'id' in raw
      ? (raw as Record<string, unknown>)
      : null)

  if (!order?.id) {
    return { ok: false, message: 'No recent order found for this phone' }
  }

  const trackingNumber =
    typeof order.tracking_number === 'string' ? order.tracking_number : ''
  const displayTrackingId =
    trackingNumber.trim() || formatOrderLabelBarcode(String(order.id))
  const trackingUrl = publicCustomerTrackingUrl({
    orderId: String(order.id),
    trackingNumber,
  })

  let status: TrackingStatusPayload | null = null
  try {
    status = (await ladiesbagsOrdersRequest('GET', '/api/domex/status', {
      query: { trackingNo: displayTrackingId },
      auth: false,
    })) as TrackingStatusPayload
  } catch {
    status = null
  }

  const text = buildCustomerTrackingText({
    displayTrackingId,
    trackingUrl,
    status,
  })

  await engineSendText({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    text,
    aiGenerated: true,
  })
  await stampSummary(db, conversationId, CONTEXT_BLURBS.tracking)
  return { ok: true, message: 'Tracking info sent' }
}

export async function actionSendQuotation(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  items: OrderLineItem[]
  useSinglish: boolean
}): Promise<{ ok: boolean; message: string }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    items,
    useSinglish,
  } = args
  if (!items.length) return { ok: false, message: 'No items for quotation' }

  const caption = useSinglish
    ? 'Order karanna oni nam name, address, phone number eka send karanna.'
    : 'Order pannanum na name, address, phone number anupunga.'

  const enriched = await enrichQuotationLineItems(db, accountId, items)

  try {
    const shot = await sendQuotationScreenshot({
      db,
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
      items: enriched,
      caption,
    })
    return {
      ok: true,
      message: `Quotation screenshot sent (${shot.sendMode}, ${Math.round(shot.bytes / 1024)}kb, meta=${shot.metaMediaId || 'none'}, url=${shot.publicUrl})`,
    }
  } catch (err) {
    console.error('[sales-agent] quotation screenshot failed:', err)
    const errMsg = err instanceof Error ? err.message : String(err)
    // Fallback: text quotation (same numbers)
    const lines: string[] = ['*Price Quotation*', '']
    let sub = 0
    for (const it of enriched) {
      const line = Number(it.price) * Number(it.qty)
      sub += line
      const color = it.color ? ` (${it.color})` : ''
      lines.push(`• ${it.name}${color} x${it.qty} — ${formatLkr(line)}`)
    }
    lines.push(`Shipping: ${formatLkr(QUOTATION_SHIPPING_LKR)}`)
    lines.push(`Total: ${formatLkr(sub + QUOTATION_SHIPPING_LKR)}`)
    lines.push('')
    lines.push(caption)

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: lines.join('\n'),
      aiGenerated: true,
    })
    await stampSummary(db, conversationId, CONTEXT_BLURBS.quotation)
    return {
      ok: true,
      message: `Quotation text sent (screenshot failed: ${errMsg})`,
    }
  }
}

export async function actionEditOrder(args: {
  orderId: string
  patch: Record<string, unknown>
}): Promise<{ ok: boolean; message: string }> {
  try {
    await updateOrderOnLadiesbags(args.orderId, args.patch)
    return { ok: true, message: `Order ${args.orderId} updated` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Edit failed'
    return { ok: false, message: msg }
  }
}

export async function actionMarkHuman(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  reason?: string
}): Promise<{ ok: boolean; message: string }> {
  const { db, accountId, conversationId, contactId, reason } = args
  await addNamedTag(db, accountId, contactId, 'Human')
  await db
    .from('conversations')
    .update({
      ai_autoreply_disabled: true,
      ai_handoff_summary: reason?.trim()
        ? `Sales agent → Human: ${reason.trim().slice(0, 200)}`
        : 'Sales agent → Human tag',
    })
    .eq('id', conversationId)
  return { ok: true, message: 'Marked Human; automation paused' }
}

/** Heuristic: message looks like shipping / contact details. */
export function isAddressLikeMessage(text: string): boolean {
  const t = text.trim()
  if (!t) return false

  const compact = t.replace(/[\s-]/g, '')
  const hasPhone = /\b0\d{9}\b|\+94\d{9}/.test(compact)
  const lines = t
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const lineCount = lines.length
  const hasHouseNo =
    /\bno\.?\s*\d{1,4}\b|\b\d{1,4}\s*\/\s*\d{0,3}\b|#\s*\d{1,4}\b/i.test(t)
  const hasPlace =
    /road|lane|street|avenue|junction|pura|watta|gama|city|district|kandiya|mawatha|mw\b|para\b|town|village/i.test(
      t,
    )
  const hasLabel =
    /📌|name\s*:|address\s*:|district\s*:|contact\s*0?\d|delivery\s*(address|details)?/i.test(
      t,
    )

  // Explicit labeled shipping form
  if (hasLabel && (hasPhone || lineCount >= 2)) return true

  // Bare block like:
  // Chamod / No 280 / Uttalapura / Dehiattakandiya / 0779522100
  // (no need to say "this is my address")
  if (hasPhone && lineCount >= 3) return true
  if (hasPhone && lineCount >= 2 && (hasPlace || hasHouseNo)) return true

  let score = 0
  if (hasLabel) score += 5
  if (hasPhone) score += 3
  if (hasPlace) score += 2
  if (hasHouseNo) score += 1
  if (lineCount >= 2) score += 2
  if (lineCount >= 4) score += 1
  if (t.length >= 40) score += 1
  return score >= 5
}
