import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchOrderByPhone,
  updateOrderOnLadiesbags,
} from '@/lib/orders/ladiesbags-orders'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import type { OrderLineItem } from '@/lib/orders/constants'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import { engineSendText } from '@/lib/flows/meta-send'
import {
  COLOR_ALIASES,
  extractColorsFromText,
  extractOrderIntents,
  KNOWN_COLORS,
  parseOrderPending,
  patchRequestedItemsColor,
  quotedItemsFromPending,
  toOrderLineItems,
  toPendingQuotedItems,
  type OrderPendingQuotedItem,
  type OrderPendingState,
} from './order-intent'
import { normalizeMatchText } from './normalize'
import type { MatchableQuickReply } from './match-products'
import { sendOrderConfirmScreenshot } from './order-screenshot'
import { addNamedTag } from './tags'
import { actionSendQuotation } from './actions/orders'

/**
 * True when the customer wants to change an already-created order
 * (color / bag / qty) — not browse a new product or FAQ QR.
 */
export function isOrderEditRequest(text: string): boolean {
  const t = text.toLowerCase().trim()
  if (!t || t.length > 200) return false

  const hasColor = extractColorsFromText(t).length > 0
  const changeCue =
    /\b(change|chang|venas|wenas|update|edit|alter|replace|swap)\b/.test(t) ||
    /\b(wenas|venas)\s*karanna\b/.test(t) ||
    /\b(color|colour|bag|item)\s+eka\s+/.test(t) ||
    /\b(karanna|karamu|denna|dannna)\b/.test(t) ||
    /\b(pata|patha)\b/.test(t)

  // "white karanna" / "bag eka white" / "rathu pata denna"
  if (hasColor && changeCue) return true
  if (
    hasColor &&
    /\b(order|odar|oda)\b/.test(t) &&
    /\b(change|venas|update|edit|color|colour)\b/.test(t)
  ) {
    return true
  }
  // Short color-change: "white eka denna", "mata rathu pata bag eka denna"
  if (
    hasColor &&
    t.split(/\s+/).length <= 10 &&
    /\b(denna|karanna|karamu|eka|color|colour|pata|patha|bag)\b/.test(t) &&
    !/\b(price|kohomada|ganna\s+oni|address)\b/.test(t)
  ) {
    return true
  }
  return false
}

export function extractEditColor(text: string): string | null {
  const colors = extractColorsFromText(text)
  return colors[0] || null
}

type OrderItem = {
  name?: string
  color?: string
  price?: number | string
  quantity?: number | string
  productId?: string
  image?: string
}

/**
 * Change color on conversation-saved requested bags (pre-order memory).
 * Keeps product name + qty; refreshes catalog image when possible.
 */
export async function actionPatchPendingItemsColor(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  newColor: string
  inboundText: string
  catalog: MatchableQuickReply[]
  useSinglish: boolean
}): Promise<{ ok: boolean; message: string }> {
  const {
    db,
    conversationId,
    contactId,
    accountId,
    configOwnerUserId,
    newColor,
    inboundText,
    catalog,
    useSinglish,
  } = args

  const { data } = await db
    .from('conversations')
    .select('sa_order_pending')
    .eq('id', conversationId)
    .maybeSingle()

  const pending = parseOrderPending(data?.sa_order_pending)
  if (pending?.type !== 'awaiting_address' || !pending.items.length) {
    return { ok: false, message: 'No saved bags to update' }
  }

  const named = extractOrderIntents([inboundText], catalog)
  const targetName = named[0]?.name || null
  let patched = patchRequestedItemsColor(pending.items, newColor, targetName)

  patched = await Promise.all(
    patched.map(async (it) => {
      if (!it.productId) return { ...it, color: newColor }
      try {
        const p = await fetchCatalogProduct(it.productId)
        if (!p) return { ...it, color: newColor }
        const color =
          p.colors.find((c) => c.toLowerCase() === newColor.toLowerCase()) ||
          newColor
        return {
          ...it,
          name: p.name || it.name,
          color,
          image: catalogImageForColor(p, color) || it.image,
          price: it.price > 0 ? it.price : p.price || 0,
        }
      } catch {
        return { ...it, color: newColor }
      }
    }),
  )

  const next: OrderPendingState = {
    type: 'awaiting_address',
    items: patched,
    askedAt: new Date().toISOString(),
  }
  await db
    .from('conversations')
    .update({ sa_order_pending: next })
    .eq('id', conversationId)

  const names = patched
    .map((i) => `${i.name} (${i.color || '—'}) x${i.qty}`)
    .join(', ')
  const text = useSinglish
    ? `Update una: ${names}. Address eka send karanna order ekata.`
    : `Update aachu: ${names}. Address anupunga order ku.`

  await engineSendText({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    text,
    aiGenerated: true,
  })

  return {
    ok: true,
    message: `Updated pending bags color → ${newColor} (${patched.length} item(s))`,
  }
}

/**
 * True when the customer wants to ADD bag(s) onto an existing order
 * (not replace the whole cart).
 */
export function isAddToOrderRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false
  return (
    /\b(add|added|adding)\b/.test(t) ||
    /\b(ekakuth|ekak\s*uth|ekakath|ekath)\b/.test(t) ||
    // "dekakuth" = two more also; "thunakuth" = three more
    /\b(dekakuth|dekak\s*uth|deka\s*uth|thunakuth|thunak\s*uth)\b/.test(t) ||
    /\b(thawa|another|plus)\b/.test(t) ||
    /\b(add\s*karaganna|karaganna\s*oni|include|uth\s+add)\b/.test(t) ||
    /\bmeka(ta|ට)?\b.*\b(add|ekakuth|karaganna)\b/.test(t)
  )
}

/** Line key for order items — product + color (same bag, different color = separate lines). */
export function orderLineItemKey(item: {
  productId?: string | null
  name?: string | null
  color?: string | null
}): string {
  const color = normalizeMatchText(item.color || '') || '_'
  if (item.productId) return `id:${item.productId}|c:${color}`
  return `name:${normalizeMatchText(item.name || '')}|c:${color}`
}

/**
 * Append/merge incoming bags onto existing order lines.
 * Same product+color → qty summed; otherwise new line kept.
 */
export function mergeOrderItemsAdd(
  existing: OrderItem[],
  incoming: OrderItem[],
): OrderItem[] {
  const map = new Map<string, OrderItem>()
  for (const it of existing) {
    const name = typeof it.name === 'string' ? it.name : ''
    if (!name) continue
    const key = orderLineItemKey(it)
    map.set(key, {
      ...it,
      name,
      quantity: Math.max(1, Number(it.quantity) || 1),
    })
  }
  for (const it of incoming) {
    const name = typeof it.name === 'string' ? it.name : ''
    if (!name) continue
    const key = orderLineItemKey(it)
    const prev = map.get(key)
    const addQty = Math.max(1, Number(it.quantity) || 1)
    if (!prev) {
      map.set(key, {
        ...it,
        name,
        quantity: addQty,
      })
      continue
    }
    map.set(key, {
      ...prev,
      productId: it.productId || prev.productId,
      name: it.name || prev.name,
      color: it.color?.toString().trim() ? it.color : prev.color,
      quantity: Math.max(1, Number(prev.quantity) || 1) + addQty,
      price:
        Number(it.price) > 0
          ? it.price
          : prev.price,
      image: it.image || prev.image,
    })
  }
  return Array.from(map.values())
}

function orderItemsToApi(items: OrderItem[]): OrderItem[] {
  return items.map((it) => ({
    productId: it.productId,
    name: it.name,
    color: it.color || '',
    quantity: Math.max(1, Number(it.quantity) || 1),
    price: Number(it.price) || 0,
    image: it.image,
  }))
}

function lineItemsToOrderItems(items: OrderLineItem[]): OrderItem[] {
  return items.map((it) => ({
    productId: it.productId,
    name: it.name,
    color: it.color || '',
    quantity: Math.max(1, it.qty || 1),
    price: Number(it.price) || 0,
    image: it.image,
  }))
}

async function refetchOrder(
  orderId: string,
  contactPhone?: string | null,
): Promise<Record<string, unknown> | null> {
  if (contactPhone) {
    try {
      const fresh = (await fetchOrderByPhone({
        phone: contactPhone,
        days: 7,
        whatsappOnly: false,
      })) as { order?: Record<string, unknown> }
      if (fresh?.order && typeof fresh.order.id === 'string') {
        return fresh.order
      }
    } catch {
      /* fall through */
    }
  }
  return { id: orderId }
}

/**
 * After order create/update — send the same confirm screenshot + caption
 * used on create, and ensure Pending tag.
 */
async function sendUpdatedOrderConfirm(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  order: Record<string, unknown>
  itemsFallback?: OrderItem[]
}): Promise<{ ok: boolean; detail: string }> {
  let order = args.order
  if (
    (!Array.isArray(order.items) || order.items.length === 0) &&
    args.itemsFallback?.length
  ) {
    order = { ...order, items: args.itemsFallback }
  }

  try {
    const shot = await sendOrderConfirmScreenshot({
      db: args.db,
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      configOwnerUserId: args.configOwnerUserId,
      order,
    })
    await addNamedTag(args.db, args.accountId, args.contactId, 'Pending')
    return {
      ok: true,
      detail: `confirm screenshot ${shot.sendMode} ${Math.round(shot.bytes / 1024)}kb`,
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[sales-agent] update order screenshot failed:', err)
    return { ok: false, detail: `screenshot failed: ${errMsg}` }
  }
}

/**
 * Change item color(s) on the customer's latest order and re-send confirm screenshot.
 */
export async function actionEditOrderColor(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string
  newColor: string
  useSinglish: boolean
  /** When set, only patch matching bag name(s). */
  targetName?: string | null
}): Promise<{ ok: boolean; message: string }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    contactPhone,
    newColor,
    targetName,
  } = args

  const fresh = (await fetchOrderByPhone({
    phone: contactPhone,
    days: 7,
    whatsappOnly: false,
  })) as { order?: Record<string, unknown> }

  const order = fresh?.order
  if (!order || typeof order.id !== 'string') {
    return { ok: false, message: 'No recent order found to edit' }
  }

  const items = Array.isArray(order.items)
    ? (order.items as OrderItem[])
    : []
  if (!items.length) {
    return { ok: false, message: 'Order has no items to edit' }
  }

  const target = targetName ? normalizeMatchText(targetName) : ''

  const patched: OrderItem[] = []
  for (const it of items) {
    const name = typeof it.name === 'string' ? it.name : ''
    if (target) {
      const n = normalizeMatchText(name)
      if (!n.includes(target) && !target.includes(n)) {
        patched.push(it)
        continue
      }
    }

    let image = it.image
    const productId = typeof it.productId === 'string' ? it.productId : undefined
    if (productId) {
      try {
        const p = await fetchCatalogProduct(productId)
        if (p) {
          const color =
            p.colors.find(
              (c) => c.toLowerCase() === newColor.toLowerCase(),
            ) || newColor
          image = catalogImageForColor(p, color) || image
          patched.push({
            ...it,
            name: p.name || it.name,
            color,
            image,
            price: it.price ?? p.price,
          })
          continue
        }
      } catch {
        /* keep item with new color label */
      }
    }
    patched.push({ ...it, color: newColor, image })
  }

  await updateOrderOnLadiesbags(String(order.id), {
    items: orderItemsToApi(patched),
  })

  const refreshed =
    (await refetchOrder(String(order.id), contactPhone)) || {
      ...order,
      items: patched,
    }
  const confirm = await sendUpdatedOrderConfirm({
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    order: { ...refreshed, items: refreshed.items ?? patched },
    itemsFallback: patched,
  })

  return {
    ok: true,
    message: `Updated order ${order.id} color → ${newColor}; ${confirm.detail}`,
  }
}

export type UpdateOrderMode = 'add' | 'replace'

/** True when this phone has a recent ladiesbags order we can edit. */
export async function findRecentOrderForPhone(
  contactPhone: string | null | undefined,
): Promise<{ id: string; order: Record<string, unknown> } | null> {
  if (!contactPhone) return null
  try {
    const fresh = (await fetchOrderByPhone({
      phone: contactPhone,
      days: 7,
      whatsappOnly: false,
    })) as { order?: Record<string, unknown> }
    if (fresh?.order && typeof fresh.order.id === 'string') {
      return { id: String(fresh.order.id), order: fresh.order }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Merge pending quotation lines by product+color (sum qty on same key).
 */
export function mergePendingItemsAdd(
  existing: OrderPendingQuotedItem[],
  incoming: OrderPendingQuotedItem[],
): OrderPendingQuotedItem[] {
  const asOrder = (it: OrderPendingQuotedItem): OrderItem => ({
    productId: it.productId,
    name: it.name,
    color: it.color || '',
    quantity: it.qty,
    price: it.price,
    image: it.image,
  })
  const merged = mergeOrderItemsAdd(
    existing.map(asOrder),
    incoming.map(asOrder),
  )
  return merged.map((it) => ({
    productId: typeof it.productId === 'string' ? it.productId : undefined,
    name: String(it.name || 'Bag'),
    color: String(it.color || ''),
    qty: Math.max(1, Number(it.quantity) || 1),
    price: Number(it.price) || 0,
    image: typeof it.image === 'string' ? it.image : undefined,
  }))
}

/**
 * Pre-order path: customer wants to change bags/colors before create_order.
 * - If a quotation (sa_order_pending) exists → merge/patch it and re-send quotation.
 * - If no quotation yet but items/color are known → send a new quotation with that data.
 */
export async function actionUpdatePendingQuotation(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  useSinglish: boolean
  mode: UpdateOrderMode
  /** New/changed bags from the tool (may be empty for color-only). */
  items?: OrderLineItem[]
  color?: string | null
  targetName?: string | null
  /**
   * When false, only persist sa_order_pending (no quotation screenshot).
   * Used when the same burst also creates an order — confirm card is enough.
   */
  sendQuotation?: boolean
}): Promise<{ ok: boolean; message: string; items?: OrderLineItem[] }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    useSinglish,
    mode,
    color,
    targetName,
  } = args
  const sendQuotation = args.sendQuotation !== false

  const { data } = await db
    .from('conversations')
    .select('sa_order_pending')
    .eq('id', conversationId)
    .maybeSingle()

  const pending = parseOrderPending(data?.sa_order_pending)
  let base = quotedItemsFromPending(pending)

  // awaiting_color may have readyItems + bags without colors
  if (!base.length && pending?.type === 'awaiting_color') {
    base = [
      ...(pending.readyItems || []),
      ...pending.bags.map((b) => ({
        productId: b.productId || undefined,
        name: b.name,
        color: '',
        qty: b.qty,
        price: 0,
      })),
    ]
  }

  const incoming = toPendingQuotedItems(args.items || [])
  let next: OrderPendingQuotedItem[] = base

  if (incoming.length) {
    next =
      mode === 'replace'
        ? incoming
        : mergePendingItemsAdd(base, incoming)
  }

  if (color?.trim()) {
    if (!next.length) {
      return {
        ok: false,
        message: 'No bags in quotation memory to recolor — ask which bag first',
      }
    }
    next = patchRequestedItemsColor(next, color.trim(), targetName)
    // Refresh catalog image/price for recolored lines
    next = await Promise.all(
      next.map(async (it) => {
        if (!it.productId) return { ...it, color: it.color || color.trim() }
        try {
          const p = await fetchCatalogProduct(it.productId)
          if (!p) return it
          const c =
            p.colors.find(
              (x) => x.toLowerCase() === (it.color || color).toLowerCase(),
            ) ||
            it.color ||
            color.trim()
          return {
            ...it,
            name: p.name || it.name,
            color: c,
            price: it.price > 0 ? it.price : p.price || 0,
            image: catalogImageForColor(p, c) || it.image,
          }
        } catch {
          return it
        }
      }),
    )
  }

  if (!next.length) {
    return {
      ok: false,
      message:
        'No quotation yet and no bags provided — call find_product / generate_quote with bag details',
    }
  }

  // Enrich empty prices from catalog
  const lineItems = await Promise.all(
    toOrderLineItems(next).map(async (it) => {
      if (it.price > 0 && it.productId) return it
      if (!it.productId) return it
      try {
        const p = await fetchCatalogProduct(it.productId)
        if (!p) return it
        return {
          ...it,
          name: p.name || it.name,
          price: it.price > 0 ? it.price : p.price || 0,
          image:
            it.image ||
            catalogImageForColor(p, it.color || p.colors[0] || '') ||
            undefined,
        }
      } catch {
        return it
      }
    }),
  )

  const hadQuote = base.length > 0

  if (!sendQuotation) {
    await db
      .from('conversations')
      .update({
        sa_order_pending: {
          type: 'awaiting_address',
          items: lineItems.map((it) => ({
            productId: it.productId,
            name: it.name,
            color: it.color || '',
            qty: it.qty,
            price: it.price,
            image: it.image,
          })),
          askedAt: new Date().toISOString(),
        },
      })
      .eq('id', conversationId)
    return {
      ok: true,
      message: 'Saved cart without quotation (order confirm will include totals)',
      items: lineItems,
    }
  }

  const r = await actionSendQuotation({
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    items: lineItems,
    useSinglish,
  })

  return {
    ok: r.ok,
    message: r.ok
      ? hadQuote
        ? `Updated quotation (${mode}${color ? `, color=${color}` : ''}): ${r.message}`
        : `No prior quotation — sent new quotation: ${r.message}`
      : r.message,
    items: lineItems,
  }
}

/**
 * Update order line items (add bags onto existing order, or full replace),
 * then send the same confirm screenshot + caption as create_order.
 */
export async function actionUpdateOrderItems(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string | null
  orderId?: string | null
  /** Incoming bags from the tool call. */
  items: OrderLineItem[]
  /**
   * add = keep existing lines and append/merge (default for "ekakuth add").
   * replace = overwrite the whole items list.
   */
  mode: UpdateOrderMode
}): Promise<{ ok: boolean; message: string; items?: OrderItem[] }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    contactPhone,
    items: incomingLines,
    mode,
  } = args

  if (!incomingLines.length) {
    return { ok: false, message: 'No items provided for update' }
  }

  let orderId = args.orderId?.trim() || ''
  let existingOrder: Record<string, unknown> | null = null

  if (contactPhone) {
    try {
      const fresh = (await fetchOrderByPhone({
        phone: contactPhone,
        days: 7,
        whatsappOnly: false,
      })) as { order?: Record<string, unknown> }
      if (fresh?.order && typeof fresh.order.id === 'string') {
        existingOrder = fresh.order
        if (!orderId) orderId = String(fresh.order.id)
      }
    } catch {
      /* ignore */
    }
  }

  if (!orderId) {
    return { ok: false, message: 'No recent order found to update' }
  }

  const existingItems = Array.isArray(existingOrder?.items)
    ? (existingOrder!.items as OrderItem[])
    : []

  const incoming = lineItemsToOrderItems(incomingLines)

  // Enrich images/prices from catalog when possible
  const enrichedIncoming: OrderItem[] = []
  for (const it of incoming) {
    const productId =
      typeof it.productId === 'string' ? it.productId : undefined
    if (!productId) {
      enrichedIncoming.push(it)
      continue
    }
    try {
      const p = await fetchCatalogProduct(productId)
      if (!p) {
        enrichedIncoming.push(it)
        continue
      }
      const color =
        (typeof it.color === 'string' &&
          p.colors.find(
            (c) => c.toLowerCase() === it.color!.toLowerCase(),
          )) ||
        it.color ||
        ''
      enrichedIncoming.push({
        ...it,
        name: p.name || it.name,
        color,
        price: Number(it.price) > 0 ? it.price : p.price,
        image: catalogImageForColor(p, String(color)) || it.image,
      })
    } catch {
      enrichedIncoming.push(it)
    }
  }

  const finalItems =
    mode === 'replace'
      ? orderItemsToApi(enrichedIncoming)
      : orderItemsToApi(mergeOrderItemsAdd(existingItems, enrichedIncoming))

  if (!finalItems.length) {
    return { ok: false, message: 'Update produced empty items' }
  }

  await updateOrderOnLadiesbags(orderId, { items: finalItems })

  const refreshed =
    (await refetchOrder(orderId, contactPhone)) || {
      id: orderId,
      ...(existingOrder || {}),
      items: finalItems,
    }

  const confirm = await sendUpdatedOrderConfirm({
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    order: { ...refreshed, items: refreshed.items ?? finalItems },
    itemsFallback: finalItems,
  })

  const names = finalItems
    .map((i) => `${i.name} (${i.color || '—'}) x${i.quantity}`)
    .join(', ')

  return {
    ok: true,
    message: `Order ${orderId} updated (${mode}): ${names}; ${confirm.detail}`,
    items: finalItems,
  }
}

/** Known color tokens — used so FAQ QR matching ignores bare color overlap. */
export function isMostlyColorAsk(text: string): boolean {
  const n = normalizeMatchText(text)
  if (!n) return false
  const colors = new Set(
    [
      ...KNOWN_COLORS.map((c) => normalizeMatchText(c)),
      ...Object.keys(COLOR_ALIASES).map((c) => normalizeMatchText(c)),
    ].filter(Boolean),
  )
  const tokens = n.split(' ').filter((t) => t.length > 1)
  if (!tokens.length) return false
  const nonColor = tokens.filter(
    (t) =>
      !colors.has(t) &&
      ![
        'color',
        'colour',
        'bag',
        'bags',
        'eka',
        'oni',
        'karanna',
        'denna',
        'meka',
        'mata',
        'pata',
        'patha',
      ].includes(t),
  )
  return nonColor.length <= 1 && extractColorsFromText(text).length > 0
}
