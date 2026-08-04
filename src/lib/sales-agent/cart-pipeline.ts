import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderLineItem } from '@/lib/orders/constants'
import { engineSendText } from '@/lib/flows/meta-send'
import { actionSendQuotation } from './actions/orders'
import {
  actionUpdateOrderItems,
  actionUpdatePendingQuotation,
  findRecentOrderForPhone,
} from './order-edit-intent'
import type {
  CartIntentExtraction,
  CartOperation,
} from './cart-intent-extract'
import {
  COLOR_ALIASES,
  parseOrderPending,
  productDisplayName,
  resolveLineItems,
  type OrderPendingQuotedItem,
} from './order-intent'
import {
  matchProductsInText,
  type MatchableQuickReply,
} from './match-products'
import { normalizeMatchText } from './normalize'
import type { ReplyMode } from './language'

/** Architecture confidence gates (0–1). */
export const CART_CONFIDENCE_AUTO = 0.9
export const CART_CONFIDENCE_ASK = 0.6
export const CART_MAX_QTY = 50

export type ResolvedCartLine = {
  productId: string
  name: string
  color: string | null
  qty: number
  confidence: number
  quickReplyId?: string
  catalogMessageId?: string | null
}

export type CartClarifyReason =
  | 'ambiguous_product'
  | 'low_confidence'
  | 'invalid_color'
  | 'missing_color'
  | 'invalid_qty'
  | 'incomplete'
  | 'unknown_product'

export type CartPipelineResult = {
  handled: boolean
  quoted: boolean
  clarified: boolean
  updated: boolean
  message: string
  clarifyReason?: CartClarifyReason
  lines?: ResolvedCartLine[]
}

/**
 * Canonicalize customer color via Singlish aliases, then title-case.
 */
export function canonicalizeExtractedColor(
  raw: string | null | undefined,
): string | null {
  if (!raw || !String(raw).trim()) return null
  const n = normalizeMatchText(raw)
  if (!n) return null
  const alias = COLOR_ALIASES[n.replace(/\s+/g, '')] || COLOR_ALIASES[n]
  const base = alias || n
  return base
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/**
 * Validate color against product catalog colors (case-insensitive).
 * Returns the catalog spelling on success.
 */
export function validateProductColor(
  color: string | null,
  available: string[] | null | undefined,
): { ok: true; color: string } | { ok: false; available: string[] } {
  const avail = (available || []).filter(Boolean)
  if (!color) return { ok: false, available: avail }
  const want = normalizeMatchText(color)
  const hit = avail.find((c) => normalizeMatchText(c) === want)
  if (hit) return { ok: true, color: hit }
  // Soft match: "dark brown" vs "Dark-Brown"
  const soft = avail.find((c) => {
    const cn = normalizeMatchText(c).replace(/-/g, ' ')
    const wn = want.replace(/-/g, ' ')
    return cn === wn || cn.includes(wn) || wn.includes(cn)
  })
  if (soft) return { ok: true, color: soft }
  return { ok: false, available: avail }
}

export function validateQty(
  qty: number | null | undefined,
  opts?: { defaultQty?: number; required?: boolean },
): { ok: true; qty: number } | { ok: false; reason: 'invalid_qty' | 'missing_qty' } {
  if (qty == null || !Number.isFinite(qty)) {
    if (opts?.required) return { ok: false, reason: 'missing_qty' }
    return { ok: true, qty: opts?.defaultQty ?? 1 }
  }
  const n = Math.floor(Number(qty))
  if (n < 1 || n > CART_MAX_QTY) return { ok: false, reason: 'invalid_qty' }
  return { ok: true, qty: n }
}

/**
 * Resolve a free-text mention to a catalog product via needles/aliases.
 * Returns match confidence boost when a unique strong needle hits.
 */
export function resolveMentionedProduct(
  mentioned: string,
  catalog: MatchableQuickReply[],
): {
  qr: MatchableQuickReply | null
  matchConfidence: number
  candidates: MatchableQuickReply[]
} {
  const hits = matchProductsInText(mentioned, catalog)
  if (!hits.length) {
    // Also try matching mention as a whole against bagName
    const n = normalizeMatchText(mentioned)
    const loose = catalog.filter((qr) => {
      const name = normalizeMatchText(qr.bagName || productDisplayName(qr.title))
      return name === n || name.includes(n) || n.includes(name)
    })
    if (loose.length === 1) {
      return { qr: loose[0], matchConfidence: 0.85, candidates: loose }
    }
    if (loose.length > 1) {
      return { qr: null, matchConfidence: 0.5, candidates: loose.slice(0, 5) }
    }
    return { qr: null, matchConfidence: 0, candidates: [] }
  }
  if (hits.length === 1) {
    const bestNeedle = Math.max(
      ...hits[0].needles.map((needle) =>
        normalizeMatchText(mentioned).includes(needle) ? needle.length : 0,
      ),
      3,
    )
    const matchConfidence = Math.min(0.99, 0.75 + bestNeedle / 40)
    return { qr: hits[0], matchConfidence, candidates: hits }
  }
  // Multiple hits — prefer longest bag name uniqueness
  return {
    qr: null,
    matchConfidence: 0.55,
    candidates: hits.slice(0, 5),
  }
}

export function combineConfidence(
  llmConfidence: number,
  matchConfidence: number,
): number {
  // Unique strong catalog match can lift a mid LLM score into auto range.
  return Math.max(
    0,
    Math.min(1, Math.max(llmConfidence, (llmConfidence + matchConfidence) / 2)),
  )
}

export function buildDidYouMeanMessage(
  candidates: MatchableQuickReply[],
  useSinglish: boolean,
): string {
  const names = candidates
    .map((c) => c.bagName || productDisplayName(c.title))
    .filter(Boolean)
    .slice(0, 3)
  if (!names.length) {
    return useSinglish
      ? 'Monamada bag ekakda? Name eka kiyanna.'
      : 'Which bag do you mean? Please tell the name.'
  }
  if (names.length === 1) {
    return useSinglish
      ? `Oba kiyanne ${names[0]} da?`
      : `Did you mean ${names[0]}?`
  }
  return useSinglish
    ? `Oba kiyanne monavada — ${names.join(' / ')}?`
    : `Did you mean ${names.join(' / ')}?`
}

export function buildColorAskMessage(
  productName: string,
  available: string[],
  useSinglish: boolean,
): string {
  const list = available.length ? available.join(', ') : 'available colors'
  return useSinglish
    ? `${productName} eka thiyenne ${list}. Color ekak pick karanna.`
    : `${productName} is available in ${list}. Which color would you like?`
}

/**
 * Apply cart ops onto pending quoted items (productId-first).
 */
export function applyCartOperationToPending(
  existing: OrderPendingQuotedItem[],
  incoming: ResolvedCartLine[],
  operation: CartOperation,
  target?: { productId?: string | null; color?: string | null },
): OrderPendingQuotedItem[] {
  const toPending = (lines: ResolvedCartLine[]): OrderPendingQuotedItem[] =>
    lines
      .filter((l) => l.productId && l.color)
      .map((l) => ({
        productId: l.productId,
        name: l.name,
        color: l.color as string,
        qty: l.qty,
        price: 0,
      }))

  const op = operation || 'set'

  if (op === 'set' || op === 'add') {
    const next = toPending(incoming)
    if (op === 'set' || !existing.length) return next.length ? next : existing
    return mergePendingQuotedAdd(existing, next)
  }

  if (op === 'add_qty' || op === 'replace_qty' || op === 'remove') {
    let targetIdx = findTargetIndex(existing, target, incoming)
    if (targetIdx < 0 && existing.length === 1) targetIdx = 0
    if (targetIdx < 0) return existing

    const copy = existing.map((e) => ({ ...e }))
    if (op === 'remove') {
      copy.splice(targetIdx, 1)
      return copy
    }
    const delta = incoming[0]?.qty ?? 1
    if (op === 'add_qty') {
      copy[targetIdx] = {
        ...copy[targetIdx],
        qty: Math.max(1, Number(copy[targetIdx].qty) || 1) + delta,
      }
    } else {
      copy[targetIdx] = {
        ...copy[targetIdx],
        qty: Math.max(1, delta),
      }
    }
    return copy
  }

  return existing
}

function findTargetIndex(
  existing: OrderPendingQuotedItem[],
  target?: { productId?: string | null; color?: string | null },
  incoming?: ResolvedCartLine[],
): number {
  const pid = target?.productId || incoming?.[0]?.productId
  const color = canonicalizeExtractedColor(
    target?.color || incoming?.[0]?.color || null,
  )
  if (pid) {
    const byId = existing.findIndex((e) => {
      if (e.productId !== pid) return false
      if (!color) return true
      return normalizeMatchText(e.color) === normalizeMatchText(color)
    })
    if (byId >= 0) return byId
  }
  return existing.length ? existing.length - 1 : -1
}

export function mergePendingQuotedAdd(
  existing: OrderPendingQuotedItem[],
  incoming: OrderPendingQuotedItem[],
): OrderPendingQuotedItem[] {
  const map = new Map<string, OrderPendingQuotedItem>()
  const keyOf = (it: OrderPendingQuotedItem) =>
    `${it.productId || normalizeMatchText(it.name)}|${normalizeMatchText(it.color)}`
  for (const it of existing) map.set(keyOf(it), { ...it })
  for (const it of incoming) {
    const k = keyOf(it)
    const prev = map.get(k)
    if (!prev) {
      map.set(k, { ...it })
      continue
    }
    map.set(k, {
      ...prev,
      productId: it.productId || prev.productId,
      name: it.name || prev.name,
      qty: Math.max(1, Number(prev.qty) || 1) + Math.max(1, Number(it.qty) || 1),
      price: Number(it.price) > 0 ? it.price : prev.price,
      image: it.image || prev.image,
    })
  }
  return Array.from(map.values())
}

/**
 * Every line must have productId + qty + color (when product has colors).
 */
export function checkQuoteCompleteness(
  lines: ResolvedCartLine[],
  catalog: MatchableQuickReply[],
): { ok: true } | { ok: false; reason: CartClarifyReason; line?: ResolvedCartLine; available?: string[] } {
  if (!lines.length) return { ok: false, reason: 'incomplete' }
  for (const line of lines) {
    if (!line.productId) return { ok: false, reason: 'unknown_product', line }
    if (line.confidence < CART_CONFIDENCE_AUTO) {
      return { ok: false, reason: 'low_confidence', line }
    }
    const qr = catalog.find((c) => c.product_id === line.productId)
    const colors = qr?.colors ?? []
    if (colors.length > 0) {
      if (!line.color) return { ok: false, reason: 'missing_color', line, available: colors }
      const v = validateProductColor(line.color, colors)
      if (!v.ok) return { ok: false, reason: 'invalid_color', line, available: v.available }
      line.color = v.color
    }
    const q = validateQty(line.qty, { required: true })
    if (!q.ok) return { ok: false, reason: 'invalid_qty', line }
  }
  return { ok: true }
}

/**
 * Resolve extraction items → validated lines (or clarification payloads).
 */
export function resolveExtractionItems(
  extraction: CartIntentExtraction,
  catalog: MatchableQuickReply[],
): {
  lines: ResolvedCartLine[]
  clarify?: { reason: CartClarifyReason; messageParts: MatchableQuickReply[]; line?: ResolvedCartLine; available?: string[] }
} {
  const lines: ResolvedCartLine[] = []

  for (const item of extraction.items) {
    const resolved = resolveMentionedProduct(item.mentioned, catalog)
    const confidence = combineConfidence(item.confidence, resolved.matchConfidence)

    if (!resolved.qr) {
      if (resolved.candidates.length) {
        return {
          lines: [],
          clarify: {
            reason: 'ambiguous_product',
            messageParts: resolved.candidates,
          },
        }
      }
      return {
        lines: [],
        clarify: { reason: 'unknown_product', messageParts: [] },
      }
    }

    if (confidence < CART_CONFIDENCE_ASK) {
      return {
        lines: [],
        clarify: {
          reason: 'low_confidence',
          messageParts: [resolved.qr],
        },
      }
    }

    if (
      confidence < CART_CONFIDENCE_AUTO &&
      confidence >= CART_CONFIDENCE_ASK
    ) {
      return {
        lines: [],
        clarify: {
          reason: 'ambiguous_product',
          messageParts: resolved.candidates.length
            ? resolved.candidates
            : [resolved.qr],
        },
      }
    }

    const color = canonicalizeExtractedColor(item.color)
    const colors = resolved.qr.colors ?? []
    let resolvedColor: string | null = color
    if (color && colors.length) {
      const v = validateProductColor(color, colors)
      if (!v.ok) {
        return {
          lines: [],
          clarify: {
            reason: 'invalid_color',
            messageParts: [resolved.qr],
            available: v.available,
            line: {
              productId: resolved.qr.product_id || '',
              name:
                resolved.qr.bagName ||
                productDisplayName(resolved.qr.title),
              color,
              qty: item.qty ?? 1,
              confidence,
            },
          },
        }
      }
      resolvedColor = v.color
    }

    const qtyRes = validateQty(item.qty, { defaultQty: 1 })
    if (!qtyRes.ok) {
      return {
        lines: [],
        clarify: { reason: 'invalid_qty', messageParts: [resolved.qr] },
      }
    }

    lines.push({
      productId: resolved.qr.product_id || '',
      name: resolved.qr.bagName || productDisplayName(resolved.qr.title),
      color: resolvedColor,
      qty: qtyRes.qty,
      confidence,
      quickReplyId: resolved.qr.id,
      catalogMessageId: resolved.qr.catalog_message_id,
    })
  }

  // Qty-only ops without items — use target mention if present
  if (
    !lines.length &&
    (extraction.operation === 'add_qty' ||
      extraction.operation === 'replace_qty' ||
      extraction.operation === 'remove') &&
    extraction.target.mentioned
  ) {
    const resolved = resolveMentionedProduct(
      extraction.target.mentioned,
      catalog,
    )
    if (resolved.qr?.product_id) {
      lines.push({
        productId: resolved.qr.product_id,
        name: resolved.qr.bagName || productDisplayName(resolved.qr.title),
        color: canonicalizeExtractedColor(extraction.target.color),
        qty: 1,
        confidence: combineConfidence(0.9, resolved.matchConfidence),
        quickReplyId: resolved.qr.id,
        catalogMessageId: resolved.qr.catalog_message_id,
      })
    }
  }

  return { lines }
}

function pendingToResolved(
  items: OrderPendingQuotedItem[],
): ResolvedCartLine[] {
  return items.map((it) => ({
    productId: it.productId || '',
    name: it.name,
    color: it.color || null,
    qty: Math.max(1, Number(it.qty) || 1),
    confidence: 0.99,
  }))
}

async function sendClarify(
  args: {
    db: SupabaseClient
    accountId: string
    conversationId: string
    contactId: string
    configOwnerUserId: string
  },
  text: string,
): Promise<void> {
  await engineSendText({
    accountId: args.accountId,
    userId: args.configOwnerUserId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text: text.slice(0, 1500),
    aiGenerated: true,
  })
}

/**
 * Full extract→validate→order-state→quote pipeline.
 * Never sends a partial quotation.
 */
export async function runCartPipeline(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string | null
  extraction: CartIntentExtraction
  productCatalog: MatchableQuickReply[]
  useSinglish: boolean
  replyMode?: ReplyMode
  quotationEnabled: boolean
  editOrderEnabled: boolean
}): Promise<CartPipelineResult> {
  const {
    db,
    conversationId,
    extraction,
    productCatalog,
    useSinglish,
    quotationEnabled,
    editOrderEnabled,
  } = args

  if (extraction.intent === 'none') {
    return {
      handled: false,
      quoted: false,
      clarified: false,
      updated: false,
      message: 'no cart intent',
    }
  }

  const { lines: resolved, clarify } = resolveExtractionItems(
    extraction,
    productCatalog,
  )

  if (clarify) {
    let text = ''
    if (
      clarify.reason === 'ambiguous_product' ||
      clarify.reason === 'low_confidence'
    ) {
      text = buildDidYouMeanMessage(clarify.messageParts, useSinglish)
    } else if (
      clarify.reason === 'invalid_color' ||
      clarify.reason === 'missing_color'
    ) {
      const name =
        clarify.line?.name ||
        clarify.messageParts[0]?.bagName ||
        'Bag'
      text = buildColorAskMessage(
        name,
        clarify.available || clarify.messageParts[0]?.colors || [],
        useSinglish,
      )
    } else if (clarify.reason === 'invalid_qty') {
      text = useSinglish
        ? 'Quantity eka hariyata kiyanna (1–50).'
        : 'Please tell a valid quantity (1–50).'
    } else {
      text = useSinglish
        ? 'Bag name eka hariyata kiyanna.'
        : 'Which bag would you like?'
    }
    await sendClarify(args, text)
    return {
      handled: true,
      quoted: false,
      clarified: true,
      updated: false,
      message: text,
      clarifyReason: clarify.reason,
    }
  }

  const { data: conv } = await db
    .from('conversations')
    .select('sa_order_pending')
    .eq('id', conversationId)
    .maybeSingle()
  const pending = parseOrderPending(conv?.sa_order_pending)
  const existingPending: OrderPendingQuotedItem[] =
    pending?.type === 'awaiting_address'
      ? pending.items
      : pending?.type === 'awaiting_color'
        ? [...(pending.readyItems || [])]
        : []

  const operation: CartOperation =
    extraction.operation ||
    (extraction.intent === 'edit_cart' ? 'add' : 'set')

  // Resolve target productId from extraction.target
  let targetPid: string | null = null
  if (extraction.target.mentioned) {
    const t = resolveMentionedProduct(extraction.target.mentioned, productCatalog)
    targetPid = t.qr?.product_id || null
  }

  const nextPending = applyCartOperationToPending(
    existingPending,
    resolved,
    operation,
    {
      productId: targetPid,
      color: extraction.target.color,
    },
  )

  const workingLines =
    nextPending.length > 0
      ? pendingToResolved(nextPending)
      : resolved

  // Completeness gate — never partial quote
  const complete = checkQuoteCompleteness(workingLines, productCatalog)
  if (!complete.ok) {
    let text = ''
    if (complete.reason === 'missing_color' || complete.reason === 'invalid_color') {
      text = buildColorAskMessage(
        complete.line?.name || 'Bag',
        complete.available || [],
        useSinglish,
      )
    } else if (complete.reason === 'low_confidence') {
      text = buildDidYouMeanMessage(
        productCatalog.filter((p) => p.product_id === complete.line?.productId),
        useSinglish,
      )
    } else {
      text = useSinglish
        ? 'Bag, color, saha quantity kiyala denna — e helawata quotation dennam.'
        : 'Please tell bag, color, and quantity so I can send a quotation.'
    }

    // Persist known bags with empty color as awaiting_address so the next
    // color reply can complete the quote (do not use awaiting_color — that
    // latch is for address-arrived-but-color-missing).
    if (
      (complete.reason === 'missing_color' || complete.reason === 'invalid_color') &&
      workingLines.some((l) => l.productId)
    ) {
      const items = workingLines
        .filter((l) => l.productId)
        .map((l) => ({
          productId: l.productId,
          name: l.name,
          color: l.color || '',
          qty: l.qty,
          price: 0,
        }))
      if (items.length) {
        await db
          .from('conversations')
          .update({
            sa_order_pending: {
              type: 'awaiting_address',
              items,
              askedAt: new Date().toISOString(),
            },
          })
          .eq('id', conversationId)
      }
    }

    await sendClarify(args, text)
    return {
      handled: true,
      quoted: false,
      clarified: true,
      updated: true,
      message: text,
      clarifyReason: complete.reason,
      lines: workingLines,
    }
  }

  // Live order edit path
  if (extraction.intent === 'edit_cart' && editOrderEnabled) {
    const recent = await findRecentOrderForPhone(args.contactPhone)
    if (recent) {
      const mode =
        operation === 'set' || operation === 'replace_qty'
          ? ('replace' as const)
          : ('add' as const)

      if (operation === 'remove') {
        const orderItems = (
          Array.isArray(recent.order.items) ? recent.order.items : []
        ) as Array<{
          productId?: string
          name?: string
          color?: string
          quantity?: number
          price?: number
          image?: string
        }>
        const remaining = orderItems.filter((o) => {
          const hit = workingLines.find(
            (l) =>
              l.productId &&
              l.productId === o.productId &&
              (!l.color ||
                normalizeMatchText(l.color) ===
                  normalizeMatchText(String(o.color || ''))),
          )
          return !hit
        })
        if (!remaining.length) {
          const text = useSinglish
            ? 'Order eke bags remove karanna bari — human agent ekekata kiyanna.'
            : 'Could not remove those bags — please ask a human agent.'
          await sendClarify(args, text)
          return {
            handled: true,
            quoted: false,
            clarified: true,
            updated: false,
            message: text,
          }
        }
        const r = await actionUpdateOrderItems({
          db,
          accountId: args.accountId,
          conversationId,
          contactId: args.contactId,
          configOwnerUserId: args.configOwnerUserId,
          contactPhone: args.contactPhone,
          orderId: recent.id,
          mode: 'replace',
          items: remaining.map((it) => ({
            productId: String(it.productId || ''),
            name: String(it.name || ''),
            color: String(it.color || ''),
            qty: Math.max(1, Number(it.quantity) || 1),
            price: Number(it.price) || 0,
            image: typeof it.image === 'string' ? it.image : undefined,
          })),
        })
        return {
          handled: r.ok,
          quoted: false,
          clarified: false,
          updated: r.ok,
          message: r.message,
          lines: workingLines,
        }
      }

      const r = await actionUpdateOrderItems({
        db,
        accountId: args.accountId,
        conversationId,
        contactId: args.contactId,
        configOwnerUserId: args.configOwnerUserId,
        contactPhone: args.contactPhone,
        orderId: recent.id,
        mode,
        items: workingLines.map((l) => ({
          productId: l.productId,
          name: l.name,
          color: l.color || '',
          qty: l.qty,
          price: 0,
        })),
      })
      return {
        handled: r.ok,
        quoted: false,
        clarified: false,
        updated: r.ok,
        message: r.message,
        lines: workingLines,
      }
    }
  }

  if (!quotationEnabled) {
    return {
      handled: false,
      quoted: false,
      clarified: false,
      updated: false,
      message: 'quotation disabled',
      lines: workingLines,
    }
  }

  // Deterministic quote from productId + qty + color only
  const intents = workingLines.map((l) => ({
    productId: l.productId,
    catalogMessageId: l.catalogMessageId ?? null,
    name: l.name,
    color: l.color,
    qty: l.qty,
    quickReplyId: l.quickReplyId || '',
  }))
  const priced = await resolveLineItems(intents)
  if (!priced.length || priced.some((p) => !p.productId || (!p.color && productCatalog.find((c) => c.product_id === p.productId)?.colors?.length))) {
    const text = useSinglish
      ? 'Bag, color, saha quantity kiyala denna — e helawata quotation dennam.'
      : 'Please tell bag, color, and quantity so I can send a quotation.'
    await sendClarify(args, text)
    return {
      handled: true,
      quoted: false,
      clarified: true,
      updated: false,
      message: text,
      clarifyReason: 'incomplete',
    }
  }

  // Prefer update pending quotation when editing existing quote
  if (extraction.intent === 'edit_cart' && existingPending.length) {
    const mode =
      operation === 'set' || operation === 'replace_qty'
        ? ('replace' as const)
        : ('add' as const)
    const r = await actionUpdatePendingQuotation({
      db,
      accountId: args.accountId,
      conversationId,
      contactId: args.contactId,
      configOwnerUserId: args.configOwnerUserId,
      items: priced,
      useSinglish,
      mode,
    })
    return {
      handled: r.ok,
      quoted: r.ok,
      clarified: false,
      updated: r.ok,
      message: r.message,
      lines: workingLines,
    }
  }

  const r = await actionSendQuotation({
    db,
    accountId: args.accountId,
    conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    items: priced,
    useSinglish,
  })

  return {
    handled: r.ok,
    quoted: r.ok,
    clarified: false,
    updated: r.ok,
    message: r.message,
    lines: workingLines,
  }
}

/**
 * Send a deterministic quotation only when lines are complete.
 * Used by identify auto-quote path.
 */
export async function tryDeterministicQuote(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  items: OrderLineItem[]
  productCatalog: MatchableQuickReply[]
  useSinglish: boolean
}): Promise<{ ok: boolean; message: string; clarified?: boolean }> {
  const lines: ResolvedCartLine[] = args.items.map((it) => ({
    productId: it.productId || '',
    name: it.name,
    color: it.color || null,
    qty: Math.max(1, it.qty || 1),
    confidence: 0.99,
  }))
  const complete = checkQuoteCompleteness(lines, args.productCatalog)
  if (!complete.ok) {
    let text = ''
    if (complete.reason === 'missing_color' || complete.reason === 'invalid_color') {
      text = buildColorAskMessage(
        complete.line?.name || 'Bag',
        complete.available || [],
        args.useSinglish,
      )
    } else {
      text = args.useSinglish
        ? 'Color ekak pick karanna — e helawata quotation dennam.'
        : 'Please pick a color so I can send a quotation.'
    }
    await sendClarify(args, text)
    return { ok: false, message: text, clarified: true }
  }

  const r = await actionSendQuotation({
    db: args.db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    items: args.items,
    useSinglish: args.useSinglish,
  })
  return r
}
