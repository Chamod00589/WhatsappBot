import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchOrderByPhone,
  updateOrderOnLadiesbags,
} from '@/lib/orders/ladiesbags-orders'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import { engineSendText } from '@/lib/flows/meta-send'
import {
  COLOR_ALIASES,
  extractColorsFromText,
  extractOrderIntents,
  KNOWN_COLORS,
  parseOrderPending,
  patchRequestedItemsColor,
  type OrderPendingState,
} from './order-intent'
import { normalizeMatchText } from './normalize'
import type { MatchableQuickReply } from './match-products'

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
 * Change item color(s) on the customer's latest order and confirm.
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
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    contactPhone,
    newColor,
    useSinglish,
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

  await updateOrderOnLadiesbags(String(order.id), { items: patched })

  const names = patched
    .map((i) => `${i.name || 'Bag'} (${i.color})`)
    .join(', ')
  const text = useSinglish
    ? `Order eke bag color eka update una: ${names}. Hari neda?`
    : `Order-la bag color update aachu: ${names}. Seriya?`

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
    message: `Updated order ${order.id} color → ${newColor}`,
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
