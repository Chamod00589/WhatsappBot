import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderLineItem } from '@/lib/orders/constants'
import { engineSendText } from '@/lib/flows/meta-send'
import { actionSendQuotation, isAddressLikeMessage } from './actions/orders'
import {
  actionUpdateOrderItems,
  actionUpdatePendingQuotation,
  findRecentOrderForPhone,
  isAddToOrderRequest,
} from './order-edit-intent'
import type {
  CartIntentExtraction,
  CartOperation,
} from './cart-intent-extract'
import {
  COLOR_ALIASES,
  extractAllQtys,
  extractColorsFromText,
  parseColorOnlyReply,
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
import type { AiConfig } from '@/lib/ai/types'
import {
  verifyCartChange,
  type CartLineSnapshot,
} from './cart-change-verify'

/** Architecture confidence gates (0–1). */
export const CART_CONFIDENCE_AUTO = 0.9
export const CART_CONFIDENCE_ASK = 0.6
export const CART_MAX_QTY = 50

/** Want-side cues: include "ekathukaranna" / "athukaranna" (add together). */
const COLOR_SWAP_WANT_RE =
  /\b(eken|oni|onne|denna|want|ganna|ganne|ekathu|ekathukaranna|athukaranna|ekath\s*karanna)\b/
const COLOR_SWAP_REMOVE_RE =
  /\b(ain|nathiwa|nathuwa|remove|without|epa)\b/

/**
 * "White eken oni + brown ain karanna" → want White, remove Brown.
 * Prefer per-clause matching so "oni" in the want sentence does not
 * also tag the remove sentence.
 * "White epa … brown 3k ekathukaranna" → remove White, want Brown
 * ("ain karala COLOR" treats COLOR as want, not remove).
 */
export function parseColorSwapRequest(
  text: string,
): { want: string; remove: string } | null {
  const raw = text.replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const t = raw.toLowerCase()
  const hasRemove = COLOR_SWAP_REMOVE_RE.test(t)
  const hasWant = COLOR_SWAP_WANT_RE.test(t)
  if (!hasRemove || !hasWant) return null

  const clauses = raw
    .split(/[.!?\n]+|(?=\bmeke\b)|(?=\bthawa\b)/i)
    .map((s) => s.trim())
    .filter(Boolean)

  let want: string | null = null
  let remove: string | null = null

  for (const clause of clauses.length ? clauses : [raw]) {
    const colors = extractColorsFromText(clause)
    if (!colors.length) continue
    const sl = clause.toLowerCase()
    // "ain karala brown" → color AFTER ain is the replacement (not the remove)
    const ainThenColor = /\bain\s+kara(?:la|nna)?\s+\S+/.test(sl)
    const isRemove = COLOR_SWAP_REMOVE_RE.test(sl) && !ainThenColor
    const isWant =
      COLOR_SWAP_WANT_RE.test(sl) ||
      ainThenColor ||
      (/\b(oni|onne|ganna|ganne)\b/.test(sl) && !isRemove)
    if (isRemove) remove = colors[colors.length - 1]
    if (isWant && (!isRemove || ainThenColor)) want = colors[0]
  }

  // Fallback when remove cue is "epa" on first color and want is later color
  if ((!want || !remove) && extractColorsFromText(raw).length >= 2) {
    const all = extractColorsFromText(raw)
    // "White … epa … brown …" → first=remove, last=want (common Singlish order)
    if (/\bepa\b/.test(t) || /\bain\s+kara/.test(t)) {
      remove = remove || all[0]
      want = want || all[all.length - 1]
    } else {
      want = want || all[0]
      remove = remove || all[all.length - 1]
    }
  }

  if (
    want &&
    remove &&
    normalizeMatchText(want) !== normalizeMatchText(remove)
  ) {
    return { want, remove }
  }
  return null
}

/**
 * Color named with remove language ("White eka epa", "sudu ain").
 * Skips colors that only appear after "ain karala" (those are replacements).
 */
export function pickRemoveColorFromText(text: string): string | null {
  const raw = text.replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const clauses = raw
    .split(/[.!?\n]+|(?=\bmeke\b)|(?=\bthawa\b)/i)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const clause of clauses.length ? clauses : [raw]) {
    const sl = clause.toLowerCase()
    if (/\bain\s+kara(?:la|nna)?\s+\S+/.test(sl)) continue
    if (!COLOR_SWAP_REMOVE_RE.test(sl)) continue
    const colors = extractColorsFromText(clause)
    if (colors.length) {
      return canonicalizeExtractedColor(colors[0])
    }
  }
  return null
}

/**
 * Remove a color from the cart, then upsert replacement lines (absolute qty).
 * "White epa + brown 3k" → drop White lines, set Brown qty 3, keep other bags.
 */
export function applyColorReplaceToPending(
  existing: OrderPendingQuotedItem[],
  incoming: ResolvedCartLine[],
  removeColor: string,
): OrderPendingQuotedItem[] {
  const removeN = normalizeMatchText(removeColor)
  if (!removeN) return existing

  let next = existing.filter(
    (e) => normalizeMatchText(e.color || '') !== removeN,
  )

  for (const line of incoming) {
    if (!line.productId) continue
    const color = canonicalizeExtractedColor(line.color)
    if (!color) continue
    if (normalizeMatchText(color) === removeN) continue
    const qty = Math.max(1, Number(line.qty) || 1)
    const idx = next.findIndex((n) => {
      const sameProduct = n.productId === line.productId
      return (
        sameProduct &&
        normalizeMatchText(n.color || '') === normalizeMatchText(color)
      )
    })
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        name: line.name || next[idx].name,
        color,
        qty,
      }
    } else {
      next.push({
        productId: line.productId,
        name: line.name,
        color,
        qty,
        price: 0,
      })
    }
  }
  return next
}

/**
 * Incoming line is a NEW color for a product already in the cart
 * (White in cart + Brown incoming). Same-color restatement (Pink→Pink)
 * is NOT a color change even if the product also has other colors.
 */
export function incomingIsColorChange(
  existing: OrderPendingQuotedItem[],
  incoming: ResolvedCartLine[],
): boolean {
  return incoming.some((line) => {
    if (!line.productId || !line.color) return false
    const want = normalizeMatchText(line.color)
    const sameProduct = existing.filter((e) => e.productId === line.productId)
    if (!sameProduct.length) return false
    const hasExactColor = sameProduct.some(
      (e) => normalizeMatchText(e.color || '') === want,
    )
    return !hasExactColor
  })
}

/**
 * Remove-language + a different-color incoming line → compound color replace
 * (not plain remove, not replace_qty on the old color).
 */
export function isColorReplaceEdit(args: {
  burstText: string
  removeColor: string | null | undefined
  incoming: ResolvedCartLine[]
  existing: OrderPendingQuotedItem[]
}): boolean {
  const { burstText, existing, incoming } = args
  const removeColor = canonicalizeExtractedColor(args.removeColor || null)
  if (!existing.length || !removeColor || !incoming.length) return false
  const removeN = normalizeMatchText(removeColor)
  const hasRemoveLine = existing.some(
    (e) => normalizeMatchText(e.color || '') === removeN,
  )
  if (!hasRemoveLine) return false
  const replacements = incoming.filter((l) => {
    const c = canonicalizeExtractedColor(l.color)
    return Boolean(c && normalizeMatchText(c) !== removeN)
  })
  if (!replacements.length) return false
  return (
    looksLikeColorRemoveRequest(burstText) ||
    Boolean(parseColorSwapRequest(burstText))
  )
}

export function orderItemsToPendingQuoted(
  items: Array<{
    productId?: string | null
    name?: string | null
    color?: string | null
    quantity?: number | null
    price?: number | null
    image?: string | null
  }>,
): OrderPendingQuotedItem[] {
  return items
    .filter((it) => it?.name)
    .map((it) => ({
      productId: typeof it.productId === 'string' ? it.productId : undefined,
      name: String(it.name || 'Bag'),
      color: String(it.color || ''),
      qty: Math.max(1, Number(it.quantity) || 1),
      price: Number(it.price) || 0,
      image: typeof it.image === 'string' ? it.image : undefined,
    }))
}

/** Recolor remove-color lines to want-color (same product merges qty). */
export function applyColorSwapToPending(
  items: OrderPendingQuotedItem[],
  swap: { want: string; remove: string },
): OrderPendingQuotedItem[] {
  const wantN = normalizeMatchText(swap.want)
  const removeN = normalizeMatchText(swap.remove)
  const next: OrderPendingQuotedItem[] = []
  let changed = false

  for (const it of items) {
    const c = normalizeMatchText(it.color || '')
    if (c !== removeN) {
      next.push({ ...it })
      continue
    }
    changed = true
    const qty = Math.max(1, Number(it.qty) || 1)
    const idx = next.findIndex((n) => {
      const sameProduct = it.productId
        ? n.productId === it.productId
        : normalizeMatchText(n.name) === normalizeMatchText(it.name)
      return sameProduct && normalizeMatchText(n.color || '') === wantN
    })
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        color: swap.want,
        qty: Math.max(1, Number(next[idx].qty) || 1) + qty,
      }
    } else {
      next.push({ ...it, color: swap.want, qty })
    }
  }

  return changed ? next : items
}

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
  | 'verify_failed'

export type CartPipelineResult = {
  handled: boolean
  quoted: boolean
  clarified: boolean
  updated: boolean
  message: string
  clarifyReason?: CartClarifyReason
  lines?: ResolvedCartLine[]
  /** Debug: old→new verify outcome before send. */
  verify?: {
    ok: boolean
    source: string
    reason?: string
    oldItems?: Array<{
      name: string
      color?: string
      qty: number
      productId?: string
    }>
    newItems?: Array<{
      name: string
      color?: string
      qty: number
      productId?: string
    }>
  }
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
    // Apply per incoming line so "Pink 2 + White 1" corrections update
    // each matching cart row instead of only the first.
    const lines =
      incoming.length > 0
        ? incoming
        : [
            {
              productId: target?.productId || '',
              name: '',
              color: target?.color || null,
              qty: 1,
              confidence: 1,
            } satisfies ResolvedCartLine,
          ]

    let copy = existing.map((e) => ({ ...e }))

    // Color / line remove — never fall back to deleting an unrelated last bag.
    if (op === 'remove') {
      let anyRemoved = false
      for (const line of lines) {
        let targetIdx = findTargetIndex(copy, target, [line], {
          forRemove: true,
        })
        while (targetIdx >= 0) {
          copy.splice(targetIdx, 1)
          anyRemoved = true
          targetIdx = findTargetIndex(copy, target, [line], { forRemove: true })
        }
      }
      if (!anyRemoved) {
        const removeColors = new Set(
          [
            canonicalizeExtractedColor(target?.color),
            ...lines.map((l) => canonicalizeExtractedColor(l.color)),
          ].filter((c): c is string => Boolean(c)),
        )
        if (removeColors.size) {
          copy = existing.filter(
            (e) =>
              !removeColors.has(canonicalizeExtractedColor(e.color) || ''),
          )
        }
      }
      return copy
    }

    for (const line of lines) {
      let targetIdx = findTargetIndex(copy, target, [line])
      if (targetIdx < 0 && copy.length === 1) targetIdx = 0
      if (targetIdx < 0) continue

      const delta = Math.max(1, Number(line.qty) || 1)
      if (op === 'add_qty') {
        copy[targetIdx] = {
          ...copy[targetIdx],
          qty: Math.max(1, Number(copy[targetIdx].qty) || 1) + delta,
        }
      } else {
        copy[targetIdx] = {
          ...copy[targetIdx],
          qty: delta,
        }
      }
    }
    return copy
  }

  return existing
}

/**
 * True when the customer states an absolute desired qty (or complains the
 * current count is wrong) — NOT "add one more".
 * Examples: "Pink bag 2i oni", "2k denna", "Meke 4k thiynawane".
 */
export function looksLikeAbsoluteQtyDesire(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false
  // Explicit additive language → not an absolute set
  if (isAddToOrderRequest(t)) return false
  // 2i / 2k / 2kui / 2 pcs
  if (/\b\d+\s*[ik]\b/.test(t)) return true
  if (/\b\d+\s*(kui|pieces?|pcs?)\b/.test(t)) return true
  // Singlish number words used as desired counts
  if (/\b(ekak|dekak|thunak|hatarak|pahak)\b/.test(t)) return true
  if (/\b\d+\s*(oni|onne|denna|karanna|want)\b/.test(t)) return true
  if (/\b(oni|onne|want)\b/.test(t) && /\d/.test(t)) return true
  // Complaint that cart shows the wrong count
  if (
    /\b(thiynawane|thiyenawa|thiyenne|thiyanawa|wrong|hari\s*na|incorrect)\b/.test(
      t,
    ) &&
    /\d/.test(t)
  ) {
    return true
  }
  return false
}

function pendingLineOverlapsIncoming(
  existing: OrderPendingQuotedItem[],
  incoming: ResolvedCartLine[],
): boolean {
  return incoming.some((line) => {
    if (!line.productId) return false
    const wantColor = normalizeMatchText(line.color || '')
    return existing.some((e) => {
      if (e.productId !== line.productId) return false
      if (!wantColor) return true
      return normalizeMatchText(e.color) === wantColor
    })
  })
}

/**
 * Fix LLM mistakes like edit_cart + operation=add on "Pink bag 2i oni"
 * (would SUM onto existing pink and create qty 4). Absolute qty for a
 * line already in the cart → replace_qty; explicit "ekakuth/thawa" → add.
 */
export function coerceCartOperation(args: {
  burstText: string
  operation: CartOperation
  intent: CartIntentExtraction['intent']
  existing: OrderPendingQuotedItem[]
  incoming: ResolvedCartLine[]
}): CartOperation {
  const {
    burstText,
    intent,
    existing,
    incoming,
  } = args
  let op =
    args.operation ||
    (intent === 'edit_cart' ? 'add' : intent === 'quotation' ? 'set' : null)

  if (!op) return op

  const additive = isAddToOrderRequest(burstText)
  const absolute = looksLikeAbsoluteQtyDesire(burstText)
  const overlaps =
    existing.length > 0 &&
    incoming.length > 0 &&
    pendingLineOverlapsIncoming(existing, incoming)

  // Restating desired qty for a bag already in cart must SET, not SUM.
  // Never coerce when removing/replacing a color — that becomes
  // replace_qty on the OLD color (White×3 instead of Brown×3).
  if (
    overlaps &&
    absolute &&
    !additive &&
    (op === 'add' || op === 'add_qty')
  ) {
    if (
      looksLikeColorRemoveRequest(burstText) ||
      incomingIsColorChange(existing, incoming) ||
      Boolean(parseColorSwapRequest(burstText))
    ) {
      return op
    }
    return 'replace_qty'
  }

  // Explicit "ekakuth / thawa / add" keeps additive merge —
  // BUT not when extract already listed the full cart matching pending
  // (same-turn identify saved 2+1, extract set 2+1, "thawa" must not SUM → 4+2).
  if (additive && (op === 'set' || op === 'replace_qty')) {
    if (op === 'set' && cartExtractMatchesPending(existing, incoming)) {
      return 'set'
    }
    return 'add'
  }

  return op
}

/** Extract restated the same lines+qtys already in pending (idempotent set). */
export function cartExtractMatchesPending(
  existing: OrderPendingQuotedItem[],
  incoming: ResolvedCartLine[],
): boolean {
  if (!existing.length || !incoming.length) return false
  if (existing.length !== incoming.length) return false
  return existing.every((e) => {
    const wantColor = normalizeMatchText(e.color || '')
    const line = incoming.find((l) => {
      if (!l.productId || l.productId !== e.productId) return false
      if (!wantColor) return true
      return normalizeMatchText(l.color || '') === wantColor
    })
    if (!line) return false
    return (
      Math.max(1, Number(line.qty) || 1) === Math.max(1, Number(e.qty) || 1)
    )
  })
}

function findTargetIndex(
  existing: OrderPendingQuotedItem[],
  target?: { productId?: string | null; color?: string | null },
  incoming?: ResolvedCartLine[],
  opts?: { forRemove?: boolean },
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
  // Color-only remove ("white eka epa" / "sudu pata") — match any bag of that color
  if (opts?.forRemove && color) {
    const byColor = existing.findIndex(
      (e) => normalizeMatchText(e.color) === normalizeMatchText(color),
    )
    if (byColor >= 0) return byColor
  }
  // Never fall back to "last line" on remove — that deletes the wrong bag.
  if (opts?.forRemove) return -1
  return existing.length ? existing.length - 1 : -1
}

/** Customer wants a color removed ("white eka epa", "sudu pata ain"). */
export function looksLikeColorRemoveRequest(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false
  const hasRemove =
    /\b(epa|ain|nathiwa|nathuwa|remove|without|drop)\b/.test(t) ||
    /\bain\s+karanna\b/.test(t)
  if (!hasRemove) return false
  return extractColorsFromText(t).length > 0
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
 * Keep identify-saved photo lines that the cart extract omitted
 * (e.g. extract only returned Puff while pending already has Mini from the photo).
 */
export function mergePhotoPendingIntoResolved(
  existing: OrderPendingQuotedItem[],
  resolved: ResolvedCartLine[],
): ResolvedCartLine[] {
  if (!existing.length || !resolved.length) return resolved
  const coveredPids = new Set(
    resolved.map((r) => r.productId).filter(Boolean),
  )
  const extras: ResolvedCartLine[] = []
  for (const e of existing) {
    if (!e.productId || coveredPids.has(e.productId)) continue
    extras.push({
      productId: e.productId,
      name: e.name,
      color: e.color?.trim() ? e.color : null,
      qty: Math.max(1, Number(e.qty) || 1),
      confidence: 0.99,
    })
  }
  if (!extras.length) return resolved
  return [...extras, ...resolved]
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
 * Prefers LLM-selected productId / exact catalog name; falls back to alias needles.
 */
export function resolveExtractionItems(
  extraction: CartIntentExtraction,
  catalog: MatchableQuickReply[],
): {
  lines: ResolvedCartLine[]
  clarify?: { reason: CartClarifyReason; messageParts: MatchableQuickReply[]; line?: ResolvedCartLine; available?: string[] }
} {
  const lines: ResolvedCartLine[] = []
  const byId = new Map(
    catalog.filter((c) => c.product_id).map((c) => [c.product_id as string, c]),
  )

  for (const item of extraction.items) {
    let qr: MatchableQuickReply | null = null
    let matchConfidence = 0
    let candidates: MatchableQuickReply[] = []

    if (item.productId && byId.has(item.productId)) {
      qr = byId.get(item.productId) || null
      matchConfidence = 0.99
      candidates = qr ? [qr] : []
    } else if (item.name) {
      const want = normalizeMatchText(item.name)
      const exact = catalog.find(
        (c) =>
          normalizeMatchText(c.bagName || productDisplayName(c.title)) === want,
      )
      if (exact) {
        qr = exact
        matchConfidence = 0.97
        candidates = [exact]
      }
    }

    if (!qr) {
      const resolved = resolveMentionedProduct(
        item.mentioned || item.name || '',
        catalog,
      )
      qr = resolved.qr
      matchConfidence = resolved.matchConfidence
      candidates = resolved.candidates
    }

    const confidence = combineConfidence(item.confidence, matchConfidence)

    if (!qr) {
      if (candidates.length) {
        return {
          lines: [],
          clarify: {
            reason: 'ambiguous_product',
            messageParts: candidates,
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
          messageParts: [qr],
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
          messageParts: candidates.length ? candidates : [qr],
        },
      }
    }

    const color = canonicalizeExtractedColor(item.color)
    const colors = qr.colors ?? []
    let resolvedColor: string | null = color
    if (color && colors.length) {
      const v = validateProductColor(color, colors)
      if (!v.ok) {
        return {
          lines: [],
          clarify: {
            reason: 'invalid_color',
            messageParts: [qr],
            available: v.available,
            line: {
              productId: qr.product_id || '',
              name: qr.bagName || productDisplayName(qr.title),
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
        clarify: { reason: 'invalid_qty', messageParts: [qr] },
      }
    }

    lines.push({
      productId: qr.product_id || '',
      name: qr.bagName || productDisplayName(qr.title),
      color: resolvedColor,
      qty: qtyRes.qty,
      confidence,
      quickReplyId: qr.id,
      catalogMessageId: qr.catalog_message_id,
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

/** Pending lines that still need a color. */
export function pendingMissingColor(
  items: OrderPendingQuotedItem[],
): OrderPendingQuotedItem[] {
  return items.filter((it) => !String(it.color || '').trim())
}

/**
 * Apply a color-only customer reply onto pending lines that lack color.
 * Returns null when there is nothing to fill.
 */
export function applyColorOnlyToPending(
  existing: OrderPendingQuotedItem[],
  colorRaw: string,
  catalog: MatchableQuickReply[],
): {
  items: OrderPendingQuotedItem[]
  applied: boolean
  invalidFor?: { name: string; available: string[] }
} {
  const colorCanon = canonicalizeExtractedColor(colorRaw)
  if (!colorCanon || !pendingMissingColor(existing).length) {
    return { items: existing, applied: false }
  }

  let applied = false
  let invalidFor: { name: string; available: string[] } | undefined
  const items = existing.map((e) => {
    if (String(e.color || '').trim()) return e
    const qr = catalog.find((c) => c.product_id === e.productId)
    const v = validateProductColor(colorCanon, qr?.colors)
    if (!v.ok) {
      if (!invalidFor) {
        invalidFor = {
          name: e.name,
          available: v.available,
        }
      }
      return e
    }
    applied = true
    return { ...e, color: v.color }
  })
  return { items, applied, invalidFor }
}

/**
 * Deterministic fallback when LLM extract misses bag/color/qty pairing.
 * Handles "Cloudy white 2i black 1kui denna" → Cloudy White×2 + Cloudy Black×1.
 */
export function heuristicLinesFromText(
  text: string,
  catalog: MatchableQuickReply[],
): ResolvedCartLine[] {
  const hits = matchProductsInText(text, catalog)
  if (!hits.length) return []

  const colors = extractColorsInAppearanceOrder(text)
  const qtys = extractAllQtys(text)

  // One bag + multiple colors → one line per color (zip qtys in order)
  if (hits.length === 1 && colors.length >= 2) {
    const hit = hits[0]
    const pid = hit.product_id || ''
    if (!pid) return []
    return colors.map((color, i) => {
      const v = validateProductColor(color, hit.colors)
      return {
        productId: pid,
        name: hit.bagName || productDisplayName(hit.title),
        color: v.ok ? v.color : color,
        qty: qtys[i] ?? 1,
        confidence: 0.95,
        quickReplyId: hit.id,
        catalogMessageId: hit.catalog_message_id,
      }
    })
  }

  // One bag + one color (or colors assigned by index across bags)
  return hits
    .map((hit, i) => {
      const color = colors[i] || (colors.length === 1 ? colors[0] : null)
      const v =
        color && hit.colors?.length
          ? validateProductColor(color, hit.colors)
          : null
      return {
        productId: hit.product_id || '',
        name: hit.bagName || productDisplayName(hit.title),
        color: v?.ok ? v.color : color,
        qty: qtys[i] ?? qtys[0] ?? 1,
        confidence: 0.92,
        quickReplyId: hit.id,
        catalogMessageId: hit.catalog_message_id,
      }
    })
    .filter((l) => l.productId)
}

/** Colors in the order they appear in the customer message (not catalog sort). */
export function extractColorsInAppearanceOrder(text: string): string[] {
  const all = extractColorsFromText(text)
  if (all.length <= 1) return all
  const n = normalizeMatchText(text)
  return [...all].sort((a, b) => {
    const ia = n.indexOf(normalizeMatchText(a))
    const ib = n.indexOf(normalizeMatchText(b))
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })
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
  /** Latest customer burst — used for color-only replies + heuristic parse. */
  burstText?: string
  /** AI config for edit verify LLM (optional). */
  aiConfig?: AiConfig | null
  /** Recent customer texts for verify context. */
  recentCustomerMsgs?: string[]
}): Promise<CartPipelineResult> {
  const {
    db,
    conversationId,
    productCatalog,
    useSinglish,
    quotationEnabled,
    editOrderEnabled,
  } = args
  const burstText = args.burstText || ''

  const { data: conv } = await db
    .from('conversations')
    .select('sa_order_pending')
    .eq('id', conversationId)
    .maybeSingle()
  const pending = parseOrderPending(conv?.sa_order_pending)
  let existingPending: OrderPendingQuotedItem[] =
    pending?.type === 'awaiting_address'
      ? pending.items
      : pending?.type === 'awaiting_color'
        ? [
            ...(pending.readyItems || []),
            ...pending.bags.map((b) => ({
              productId: b.productId || undefined,
              name: b.name,
              color: '',
              qty: b.qty,
              price: 0,
            })),
          ]
        : []

  // After create_order, pending is empty — seed from live order so edits
  // (color swap / remove / add) start from real order lines.
  const recentOrder =
    editOrderEnabled && args.contactPhone
      ? await findRecentOrderForPhone(args.contactPhone)
      : null
  const colorSwap = burstText.trim()
    ? parseColorSwapRequest(burstText)
    : null
  if (
    !existingPending.length &&
    recentOrder &&
    (args.extraction.intent === 'edit_cart' || colorSwap)
  ) {
    const raw = Array.isArray(recentOrder.order.items)
      ? (recentOrder.order.items as Array<{
          productId?: string
          name?: string
          color?: string
          quantity?: number
          price?: number
          image?: string
        }>)
      : []
    existingPending = orderItemsToPendingQuoted(raw)
  }

  const oldCartSnapshot: CartLineSnapshot[] = existingPending.map((it) => ({
    productId: it.productId,
    name: it.name,
    color: it.color,
    qty: it.qty,
  }))

  // Deterministic color swap ("white eken + brown ain") on live order / cart.
  // Skip when customer also stated a new qty — swap alone keeps old qty;
  // main extract path does remove + upsert with the stated count.
  const swapDeferToExtract =
    looksLikeAbsoluteQtyDesire(burstText) ||
    isAddToOrderRequest(burstText) ||
    (args.extraction.items.length > 0 &&
      args.extraction.items.some(
        (it) =>
          it.qty != null &&
          it.qty > 0 &&
          canonicalizeExtractedColor(it.color) &&
          colorSwap &&
          normalizeMatchText(canonicalizeExtractedColor(it.color) || '') ===
            normalizeMatchText(colorSwap.want),
      ))

  if (
    colorSwap &&
    existingPending.length &&
    editOrderEnabled &&
    recentOrder &&
    !swapDeferToExtract
  ) {
    const swapped = applyColorSwapToPending(existingPending, colorSwap)
    if (swapped !== existingPending) {
      const verify = await verifyCartChange({
        oldItems: oldCartSnapshot,
        newItems: swapped.map((it) => ({
          productId: it.productId,
          name: it.name,
          color: it.color,
          qty: it.qty,
        })),
        customerText: burstText,
        operation: 'set',
        intent: 'edit_cart',
        useSinglish,
        config: args.aiConfig,
        recentCustomerMsgs: args.recentCustomerMsgs,
      })
      if (!verify.ok) {
        await sendClarify(args, verify.message)
        return {
          handled: true,
          quoted: false,
          clarified: true,
          updated: false,
          message: verify.message,
          clarifyReason: 'verify_failed',
          verify: {
            ok: false,
            source: verify.source,
            reason: verify.reason,
            oldItems: oldCartSnapshot.map((i) => ({
              name: i.name,
              color: i.color || undefined,
              qty: i.qty,
            })),
            newItems: swapped.map((i) => ({
              name: i.name,
              color: i.color || undefined,
              qty: i.qty,
            })),
          },
        }
      }
      const r = await actionUpdateOrderItems({
        db,
        accountId: args.accountId,
        conversationId,
        contactId: args.contactId,
        configOwnerUserId: args.configOwnerUserId,
        contactPhone: args.contactPhone,
        orderId: recentOrder.id,
        mode: 'replace',
        items: swapped.map((l) => ({
          productId: l.productId || '',
          name: l.name,
          color: l.color || '',
          qty: l.qty,
          price: l.price || 0,
          image: l.image,
        })),
      })
      return {
        handled: r.ok,
        quoted: false,
        clarified: false,
        updated: r.ok,
        message: r.ok
          ? `${r.message} (color swap ${colorSwap.remove}→${colorSwap.want}; verified=${verify.source})`
          : r.message,
        lines: pendingToResolved(swapped),
        verify: { ok: true, source: verify.source },
      }
    }
  }
  if (
    colorSwap &&
    existingPending.length &&
    !recentOrder &&
    !swapDeferToExtract
  ) {
    existingPending = applyColorSwapToPending(existingPending, colorSwap)
    // Fall through to re-quote with swapped pending
    args = {
      ...args,
      extraction: {
        intent: 'edit_cart',
        operation: 'set',
        items: existingPending.map((it) => ({
          productId: it.productId || null,
          name: it.name,
          mentioned: it.name,
          qty: it.qty,
          color: it.color || null,
          confidence: 1,
        })),
        target: { mentioned: null, color: colorSwap.want },
      },
    }
  }
  // Color-only reply ("Black" / "Black color") while a bag awaits color.
  const colorOnly = burstText.trim()
    ? parseColorOnlyReply(burstText)
    : null
  if (colorOnly && pendingMissingColor(existingPending).length) {
    const filled = applyColorOnlyToPending(
      existingPending,
      colorOnly,
      productCatalog,
    )
    if (filled.invalidFor && !filled.applied) {
      const text = buildColorAskMessage(
        filled.invalidFor.name,
        filled.invalidFor.available,
        useSinglish,
      )
      await sendClarify(args, text)
      return {
        handled: true,
        quoted: false,
        clarified: true,
        updated: false,
        message: text,
        clarifyReason: 'invalid_color',
      }
    }
    if (filled.applied) {
      existingPending = filled.items
      // Continue below with a synthetic edit that quotes/updates the filled cart.
      args = {
        ...args,
        extraction: {
          intent: 'edit_cart',
          operation: 'add',
          items: [],
          target: { mentioned: null, color: colorOnly },
        },
      }
    }
  }

  let extraction = args.extraction

  // Color-only with nothing pending → not a cart turn
  if (extraction.intent === 'none' && !pendingMissingColor(existingPending).length) {
    // Still try heuristic if text clearly names bags (quote/edit without LLM)
    const heuristicEarly = heuristicLinesFromText(burstText, productCatalog)
    if (!heuristicEarly.length) {
      return {
        handled: false,
        quoted: false,
        clarified: false,
        updated: false,
        message: 'no cart intent',
      }
    }
    extraction = {
      intent: 'quotation',
      operation: 'set',
      items: heuristicEarly.map((l) => ({
        productId: l.productId,
        name: l.name,
        mentioned: l.name,
        qty: l.qty,
        color: l.color,
        confidence: l.confidence,
      })),
      target: { mentioned: null, color: null },
    }
  } else if (extraction.intent === 'none') {
    // Pending needs color but message wasn't color-only — leave for tools
    if (!colorOnly) {
      return {
        handled: false,
        quoted: false,
        clarified: false,
        updated: false,
        message: 'no cart intent',
      }
    }
    extraction = {
      intent: 'edit_cart',
      operation: 'add',
      items: [],
      target: { mentioned: null, color: colorOnly },
    }
  }

  let { lines: resolved, clarify } = resolveExtractionItems(
    extraction,
    productCatalog,
  )

  // If LLM mentioned a color as the "product", don't ask for bag name —
  // apply that color onto pending incomplete lines instead.
  if (
    clarify &&
    (clarify.reason === 'unknown_product' ||
      clarify.reason === 'ambiguous_product') &&
    pendingMissingColor(existingPending).length
  ) {
    const fromItems = extraction.items
      .map((i) => canonicalizeExtractedColor(i.color || i.mentioned))
      .find(Boolean)
    const colorGuess =
      colorOnly ||
      fromItems ||
      canonicalizeExtractedColor(extraction.target.color) ||
      (burstText ? parseColorOnlyReply(burstText) : null)
    if (colorGuess) {
      const filled = applyColorOnlyToPending(
        existingPending,
        colorGuess,
        productCatalog,
      )
      if (filled.applied) {
        existingPending = filled.items
        resolved = []
        clarify = undefined
      }
    }
  }

  // Heuristic fallback when extract failed to resolve products
  if (
    (clarify?.reason === 'unknown_product' ||
      (!resolved.length && extraction.items.length > 0)) &&
    burstText.trim()
  ) {
    const heuristic = heuristicLinesFromText(burstText, productCatalog)
    if (heuristic.length) {
      resolved = heuristic
      clarify = undefined
    }
  }

  // Also use heuristic when extract returned quotation/edit with empty items
  // but the burst clearly names bags (e.g. LLM dropped "cloudy").
  if (
    !clarify &&
    !resolved.length &&
    !pendingMissingColor(existingPending).length &&
    (extraction.intent === 'quotation' || extraction.intent === 'edit_cart') &&
    burstText.trim()
  ) {
    const heuristic = heuristicLinesFromText(burstText, productCatalog)
    if (heuristic.length) resolved = heuristic
  }

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

  // Color replace ("White epa + brown 3k") — use extract lines only (before
  // photo-merge), remove target color, upsert replacement with absolute qty.
  // Must run before coerce/remove or photo-merge turns this into replace_qty
  // on the old White line.
  const removeColorHint =
    canonicalizeExtractedColor(extraction.target.color) ||
    pickRemoveColorFromText(burstText) ||
    parseColorSwapRequest(burstText)?.remove ||
    null
  const colorReplace =
    existingPending.length > 0 &&
    isColorReplaceEdit({
      burstText,
      removeColor: removeColorHint,
      incoming: resolved,
      existing: existingPending,
    })

  // Photo bags saved by early identify must not be wiped when extract only
  // returns the named bag ("this bag and puff Pink 2" → keep Mini + Puff).
  // Keep photo bags when extract only returned the named bag — but never on
  // remove (would turn "remove white" into remove Mini+White targets),
  // and never on color-replace (would poison coerce via unrelated overlaps).
  if (
    !colorReplace &&
    existingPending.length &&
    resolved.length &&
    extraction.operation !== 'remove' &&
    (extraction.intent === 'quotation' || extraction.intent === 'edit_cart')
  ) {
    resolved = mergePhotoPendingIntoResolved(existingPending, resolved)
  }

  let operation: CartOperation = colorReplace
    ? 'set'
    : coerceCartOperation({
        burstText,
        operation: extraction.operation,
        intent: extraction.intent,
        existing: existingPending,
        incoming: resolved,
      })
  // Pure remove only — do not force remove when a replacement color is present
  if (
    !colorReplace &&
    looksLikeColorRemoveRequest(burstText) &&
    (operation === 'add' ||
      operation === 'set' ||
      operation === 'replace_qty' ||
      operation === 'add_qty' ||
      !operation)
  ) {
    operation = 'remove'
  }
  // Resolve target productId from extraction.target
  let targetPid: string | null = null
  if (extraction.target.mentioned) {
    const t = resolveMentionedProduct(extraction.target.mentioned, productCatalog)
    targetPid = t.qr?.product_id || null
  }

  // Color-only fill already applied → use pending as working set
  let nextPending: OrderPendingQuotedItem[]
  if (
    colorOnly &&
    existingPending.length &&
    !pendingMissingColor(existingPending).length &&
    !resolved.length
  ) {
    nextPending = existingPending
  } else if (colorReplace && removeColorHint) {
    const replacementLines = resolved.filter((l) => {
      const c = canonicalizeExtractedColor(l.color)
      return Boolean(
        c &&
          normalizeMatchText(c) !== normalizeMatchText(removeColorHint),
      )
    })
    nextPending = applyColorReplaceToPending(
      existingPending,
      replacementLines,
      removeColorHint,
    )
  } else {
    nextPending = applyCartOperationToPending(
      existingPending,
      resolved,
      operation,
      {
        productId: targetPid,
        color: extraction.target.color || colorOnly,
      },
    )
  }

  const workingLines =
    nextPending.length > 0
      ? pendingToResolved(nextPending)
      : resolved

  // Remove left nothing — don't invent a new quote / don't double-add
  if (operation === 'remove' && !workingLines.length) {
    const text = useSinglish
      ? 'White/color eka ain kala — cart eka empty una. Thawa bags thiyenawada?'
      : 'That color was removed and the cart is empty. Any bags left to quote?'
    await sendClarify(args, text)
    await db
      .from('conversations')
      .update({ sa_order_pending: null })
      .eq('id', conversationId)
    return {
      handled: true,
      quoted: false,
      clarified: true,
      updated: true,
      message: text,
      clarifyReason: 'incomplete',
      verify: {
        ok: true,
        source: 'skipped',
        oldItems: oldCartSnapshot.map((i) => ({
          name: i.name,
          color: i.color || undefined,
          qty: i.qty,
          productId: i.productId || undefined,
        })),
        newItems: [],
      },
    }
  }

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

  // Verify old→new vs customer request before sending quote/order update
  const newSnap: CartLineSnapshot[] = workingLines.map((l) => ({
    productId: l.productId,
    name: l.name,
    color: l.color,
    qty: l.qty,
  }))
  const cartSig = (items: CartLineSnapshot[]) =>
    items
      .map(
        (i) =>
          `${(i.productId || normalizeMatchText(i.name)).toLowerCase()}|${normalizeMatchText(i.color || '')}|${Math.max(1, Number(i.qty) || 1)}`,
      )
      .sort()
      .join(';')

  // Always attach old/new for debug (even when verify is skipped)
  let verifyMeta: CartPipelineResult['verify'] = {
    ok: true,
    source: 'skipped',
    oldItems: oldCartSnapshot.map((i) => ({
      name: i.name,
      color: i.color || undefined,
      qty: i.qty,
      productId: i.productId || undefined,
    })),
    newItems: newSnap.map((i) => ({
      name: i.name,
      color: i.color || undefined,
      qty: i.qty,
      productId: i.productId || undefined,
    })),
  }

  const shouldVerify =
    oldCartSnapshot.length > 0 &&
    cartSig(oldCartSnapshot) !== cartSig(newSnap)
  if (shouldVerify) {
    const verify = await verifyCartChange({
      oldItems: oldCartSnapshot,
      newItems: newSnap,
      customerText: burstText,
      operation,
      intent: extraction.intent,
      useSinglish,
      config: args.aiConfig,
      recentCustomerMsgs: args.recentCustomerMsgs,
    })
    verifyMeta = {
      ok: verify.ok,
      source: verify.source,
      reason: verify.ok ? undefined : verify.reason,
      oldItems: verifyMeta.oldItems,
      newItems: verifyMeta.newItems,
    }
    if (!verify.ok) {
      await sendClarify(args, verify.message)
      return {
        handled: true,
        quoted: false,
        clarified: true,
        updated: false,
        message: verify.message,
        clarifyReason: 'verify_failed',
        lines: workingLines,
        verify: verifyMeta,
      }
    }
  }

  // Live order edit path
  if (extraction.intent === 'edit_cart' && editOrderEnabled) {
    const recent = recentOrder || (await findRecentOrderForPhone(args.contactPhone))
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
        const remainingSnap: CartLineSnapshot[] = remaining.map((it) => ({
          productId: typeof it.productId === 'string' ? it.productId : undefined,
          name: String(it.name || 'Bag'),
          color: String(it.color || ''),
          qty: Math.max(1, Number(it.quantity) || 1),
        }))
        const removeVerify = await verifyCartChange({
          oldItems: oldCartSnapshot,
          newItems: remainingSnap,
          customerText: burstText,
          operation: 'remove',
          intent: 'edit_cart',
          useSinglish,
          config: args.aiConfig,
          recentCustomerMsgs: args.recentCustomerMsgs,
        })
        if (!removeVerify.ok) {
          await sendClarify(args, removeVerify.message)
          return {
            handled: true,
            quoted: false,
            clarified: true,
            updated: false,
            message: removeVerify.message,
            clarifyReason: 'verify_failed',
            verify: {
              ok: false,
              source: removeVerify.source,
              reason: removeVerify.reason,
              oldItems: oldCartSnapshot.map((i) => ({
                name: i.name,
                color: i.color || undefined,
                qty: i.qty,
              })),
              newItems: remainingSnap.map((i) => ({
                name: i.name,
                color: i.color || undefined,
                qty: i.qty,
              })),
            },
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
          message: r.ok
            ? `${r.message} (verified=${removeVerify.source})`
            : r.message,
          lines: workingLines,
          verify: { ok: true, source: removeVerify.source },
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
        message: r.ok
          ? `${r.message}${verifyMeta ? ` (verified=${verifyMeta.source})` : ''}`
          : r.message,
        lines: workingLines,
        verify: verifyMeta,
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

  // Address + bags in the same turn → save cart only. create_order sends
  // the order-confirm card (prices/shipping included). Never send quotation
  // and order-confirm together.
  if (isAddressLikeMessage(burstText)) {
    await savePendingQuotedItems(db, conversationId, priced)
    return {
      handled: true,
      quoted: false,
      clarified: false,
      updated: true,
      message:
        'Address in burst — saved cart without quotation (create_order should send confirm only)',
      lines: workingLines,
    }
  }

  // Prefer update pending quotation when editing existing quote.
  // `priced` is already the FULL cart after applyCartOperationToPending —
  // always replace (never add/merge) or remove ops double Mini qty.
  if (extraction.intent === 'edit_cart' && existingPending.length) {
    const r = await actionUpdatePendingQuotation({
      db,
      accountId: args.accountId,
      conversationId,
      contactId: args.contactId,
      configOwnerUserId: args.configOwnerUserId,
      items: priced,
      useSinglish,
      mode: 'replace',
    })
    return {
      handled: r.ok,
      quoted: r.ok,
      clarified: false,
      updated: r.ok,
      message: r.ok
        ? `Updated quotation (replace${operation ? `/${operation}` : ''}): ${r.message}${verifyMeta ? ` (verified=${verifyMeta.source})` : ''}`
        : r.message,
      lines: workingLines,
      verify: verifyMeta,
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
    message: r.ok
      ? `${r.message}${verifyMeta ? ` (verified=${verifyMeta.source})` : ''}`
      : r.message,
    lines: workingLines,
    verify: verifyMeta,
  }
}

/** Persist cart lines without sending a quotation screenshot. */
export async function savePendingQuotedItems(
  db: SupabaseClient,
  conversationId: string,
  items: OrderLineItem[],
): Promise<void> {
  await db
    .from('conversations')
    .update({
      sa_order_pending: {
        type: 'awaiting_address',
        items: items.map((it) => ({
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
