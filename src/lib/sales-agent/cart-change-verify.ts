import type { AiConfig, ChatMessage } from '@/lib/ai/types'
import { aiRequestTimeoutMs, MAX_OUTPUT_TOKENS } from '@/lib/ai/defaults'
import {
  GEMINI_OPENAI_URL,
  buildGeminiAttempts,
  shouldRetryGeminiAttempt,
} from '@/lib/ai/providers/gemini'
import {
  isOpenRouterPrivacyError,
  isOpenRouterRateLimitError,
  openRouterClientRetryModels,
  openRouterFallbackModels,
  openRouterProviderPreferences,
  OPENROUTER_ZDR_FALLBACK_MODEL,
  shouldSuggestOpenRouterZdrFallback,
} from '@/lib/ai/providers/openrouter-routing'
import { extractColorsFromText } from './order-intent'
import { normalizeMatchText } from './normalize'
import { isAddToOrderRequest } from './order-edit-intent'
import type { CartOperation } from './cart-intent-extract'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type CartLineSnapshot = {
  productId?: string | null
  name: string
  color?: string | null
  qty: number
}

export type CartChangeVerifyResult =
  | { ok: true; source: 'deterministic' | 'llm' | 'skipped' }
  | {
      ok: false
      source: 'deterministic' | 'llm'
      reason: string
      /** Customer-facing clarify text (Singlish/English). */
      message: string
    }

/** Local copy — avoid circular import with cart-pipeline. */
function parseColorSwapHint(
  text: string,
): { want: string; remove: string } | null {
  const raw = text.replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const t = raw.toLowerCase()
  if (!/\b(ain|nathiwa|nathuwa|remove|without)\b/.test(t)) return null
  if (!/\b(eken|oni|onne|denna|want|ganna|ganne)\b/.test(t)) return null
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
    const isRemove = /\b(ain|nathiwa|nathuwa|remove|without)\b/.test(sl)
    const isWant =
      /\b(eken|denna|want)\b/.test(sl) ||
      (/\b(oni|onne|ganna|ganne)\b/.test(sl) && !isRemove)
    if (isRemove) remove = colors[colors.length - 1]
    if (isWant && !isRemove) want = colors[0]
  }
  if ((!want || !remove) && extractColorsFromText(raw).length >= 2) {
    const all = extractColorsFromText(raw)
    want = want || all[0]
    remove = remove || all[all.length - 1]
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

function looksLikeAbsoluteQty(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t || isAddToOrderRequest(t)) return false
  if (/\b\d+\s*[ik]\b/.test(t)) return true
  if (/\b(ekak|dekak|thunak|hatarak|pahak)\b/.test(t)) return true
  if (/\b\d+\s*(oni|onne|denna|want)\b/.test(t)) return true
  return false
}

function lineKey(it: CartLineSnapshot): string {
  const pid = (it.productId || '').trim()
  const color = normalizeMatchText(it.color || '') || '_'
  if (pid) return `id:${pid}|c:${color}`
  return `name:${normalizeMatchText(it.name)}|c:${color}`
}

function formatLines(items: CartLineSnapshot[]): string {
  if (!items.length) return '(empty)'
  return items
    .map(
      (it) =>
        `${it.name}${it.color ? ` / ${it.color}` : ''} x${Math.max(1, Number(it.qty) || 1)}` +
        (it.productId ? ` [${it.productId}]` : ''),
    )
    .join('\n')
}

function totalQty(items: CartLineSnapshot[]): number {
  return items.reduce((s, it) => s + Math.max(1, Number(it.qty) || 1), 0)
}

function toMap(items: CartLineSnapshot[]): Map<string, CartLineSnapshot> {
  const m = new Map<string, CartLineSnapshot>()
  for (const it of items) {
    if (!it?.name) continue
    m.set(lineKey(it), {
      ...it,
      qty: Math.max(1, Number(it.qty) || 1),
    })
  }
  return m
}

/**
 * Fast rules: catch doubled qty, wrong color-swap, invented bags, dropped lines.
 * Returns null when deterministic checks pass (may still need LLM).
 */
export function verifyCartChangeDeterministic(args: {
  oldItems: CartLineSnapshot[]
  newItems: CartLineSnapshot[]
  customerText: string
  operation?: CartOperation
  useSinglish?: boolean
}): CartChangeVerifyResult | null {
  const {
    oldItems,
    newItems,
    customerText,
    operation,
    useSinglish = true,
  } = args
  const text = customerText.toLowerCase().replace(/\s+/g, ' ').trim()
  const oldMap = toMap(oldItems)
  const newMap = toMap(newItems)
  const clarify = (reason: string, en: string, si: string): CartChangeVerifyResult => ({
    ok: false,
    source: 'deterministic',
    reason,
    message: useSinglish ? si : en,
  })

  // First quote / empty old — nothing to verify against
  if (!oldItems.length) return null

  if (!newItems.length) {
    return clarify(
      'empty_after_edit',
      'I could not apply that change safely — which bags should stay on the quote/order?',
      'Change eka apply karanna bari una — quote/order eke mona bags thiyenna oni kiyanna?',
    )
  }

  // Exact double of every overlapping line without "double/dekakuth" language
  let allDoubled = oldMap.size > 0
  let anyOverlap = false
  for (const [k, prev] of oldMap) {
    const next = newMap.get(k)
    if (!next) {
      allDoubled = false
      continue
    }
    anyOverlap = true
    if (next.qty !== prev.qty * 2) allDoubled = false
  }
  if (
    anyOverlap &&
    allDoubled &&
    newMap.size === oldMap.size &&
    !/\b(double|twice|dekakuth|x\s*2)\b/.test(text)
  ) {
    return clarify(
      'qty_doubled',
      'That would double the quantities — please confirm the exact qty for each bag.',
      'Eken qty double wenawa — bag ekakin hariyata kiyanna kochchara oni.',
    )
  }

  // Color swap: remove color must leave; want color must appear on that product
  const swap = parseColorSwapHint(customerText)
  if (swap) {
    const removeN = normalizeMatchText(swap.remove)
    const wantN = normalizeMatchText(swap.want)
    const stillRemove = [...newMap.values()].filter(
      (it) => normalizeMatchText(it.color || '') === removeN,
    )
    const hadRemove = [...oldMap.values()].filter(
      (it) => normalizeMatchText(it.color || '') === removeN,
    )
    if (hadRemove.length && stillRemove.length) {
      return clarify(
        'color_swap_remove_left',
        `Still seeing ${swap.remove} on the order — should I change those to ${swap.want}?`,
        `${swap.remove} color eka thama thiyenawa — ${swap.want} karanna da?`,
      )
    }
    const wantOnNew = [...newMap.values()].some(
      (it) => normalizeMatchText(it.color || '') === wantN,
    )
    if (hadRemove.length && !wantOnNew) {
      return clarify(
        'color_swap_want_missing',
        `I could not set ${swap.want} from your request. Which bag should be ${swap.want}?`,
        `${swap.want} color eka set karanna bari una — mona bag eka ${swap.want} karanna da?`,
      )
    }
  }

  // Remove op: requested remove colors/lines should be gone
  if (operation === 'remove') {
    const removeColors = extractColorsFromText(customerText).map((c) =>
      normalizeMatchText(c),
    )
    for (const c of removeColors) {
      if (!c) continue
      if (
        /\b(ain|nathiwa|nathuwa|remove|without)\b/.test(text) &&
        [...newMap.values()].some((it) => normalizeMatchText(it.color || '') === c) &&
        [...oldMap.values()].some((it) => normalizeMatchText(it.color || '') === c)
      ) {
        // Only fail if customer clearly wanted that color removed
        const nearRemove = new RegExp(
          `${c}.{0,24}\\b(ain|nathiwa|nathuwa|remove|without)\\b|\\b(ain|nathiwa|nathuwa|remove|without)\\b.{0,24}${c}`,
          'i',
        )
        if (nearRemove.test(text)) {
          return clarify(
            'remove_incomplete',
            `Still seeing ${c} — should I remove that color from the order?`,
            `${c} color eka thama thiyenawa — remove karanna da?`,
          )
        }
      }
    }
  }

  // Additive: should not wipe unrelated old lines
  if (
    (operation === 'add' || operation === 'add_qty' || isAddToOrderRequest(text)) &&
    oldItems.length >= 1 &&
    newItems.length < oldItems.length
  ) {
    return clarify(
      'add_dropped_lines',
      'Adding a bag should keep your previous items — please say which bags to keep.',
      'Aluth bag add karaddi pera bags ain wela — mona bags thiyenna oni kiyanna?',
    )
  }

  // Absolute qty restatement: avoid huge jumps without matching number in text
  if (looksLikeAbsoluteQty(text) && !isAddToOrderRequest(text)) {
    for (const [k, next] of newMap) {
      const prev = oldMap.get(k)
      if (!prev) continue
      if (next.qty >= prev.qty * 2 && next.qty > prev.qty + 1) {
        const mentioned = text.match(/\b(\d{1,2})\s*[ik]?\b/)
        const n = mentioned ? Number(mentioned[1]) : null
        if (n != null && next.qty !== n && next.qty !== n * 2) {
          /* allow */
        }
        if (n != null && next.qty === n * 2 && n === prev.qty) {
          return clarify(
            'qty_doubled_absolute',
            `Qty looks doubled (${prev.qty}→${next.qty}). Did you want ${n} total?`,
            `Qty eka double wage (${prev.qty}→${next.qty}). ${n}k total da?`,
          )
        }
      }
    }
  }

  // Invented product id not in old and name tokens not in customer text
  for (const it of newMap.values()) {
    const k = lineKey(it)
    if (oldMap.has(k)) continue
    // Same product different color is OK (color change / add color)
    const sameProduct = [...oldMap.values()].some(
      (o) =>
        (it.productId && o.productId === it.productId) ||
        normalizeMatchText(o.name) === normalizeMatchText(it.name),
    )
    if (sameProduct) continue
    const nameTok = normalizeMatchText(it.name)
      .split(/\s+/)
      .filter((t) => t.length >= 4 && t !== 'bag' && t !== 'shoulder')
    const textN = normalizeMatchText(customerText)
    const mentioned =
      nameTok.some((t) => textN.includes(t)) ||
      /\b(me\s+bag|this\s+bag|meka|meke)\b/.test(text)
    if (!mentioned && operation !== 'set') {
      return clarify(
        'invented_bag',
        `I almost added ${it.name} but it was not in your request. Which bag did you mean?`,
        `${it.name} add karanna haduwa — eka request eke nehe. Mona bag eka da?`,
      )
    }
  }

  // Total qty exploded without add language
  const oldT = totalQty(oldItems)
  const newT = totalQty(newItems)
  if (
    oldT > 0 &&
    newT >= oldT * 2 &&
    newT > oldT + 1 &&
    !isAddToOrderRequest(text) &&
    !/\b(double|all|okkoma)\b/.test(text)
  ) {
    return clarify(
      'total_qty_exploded',
      `Total pieces jumped ${oldT}→${newT}. Please confirm quantities.`,
      `Total qty ${oldT}→${newT} una — hariyata quantity kiyanna.`,
    )
  }

  return null
}

/**
 * Verify an edit before sending updated quotation / order confirm.
 * Deterministic rules first; LLM second when editing an existing cart/order.
 */
export async function verifyCartChange(args: {
  oldItems: CartLineSnapshot[]
  newItems: CartLineSnapshot[]
  customerText: string
  operation?: CartOperation
  /** Ordered actions summary from the pipeline (preferred over operation). */
  actionsSummary?: string
  intent?: string | null
  useSinglish?: boolean
  /** When set, run a short LLM confirm for edits. */
  config?: AiConfig | null
  recentCustomerMsgs?: string[]
}): Promise<CartChangeVerifyResult> {
  const {
    oldItems,
    newItems,
    customerText,
    operation = null,
    actionsSummary,
    intent,
    useSinglish = true,
    config,
    recentCustomerMsgs = [],
  } = args

  // Brand-new quotation with no prior cart — skip
  if (!oldItems.length && intent !== 'edit_cart') {
    return { ok: true, source: 'skipped' }
  }

  const det = verifyCartChangeDeterministic({
    oldItems,
    newItems,
    customerText,
    operation,
    useSinglish,
  })
  if (det && !det.ok) return det

  const needsLlm = Boolean(config) && oldItems.length > 0

  if (!needsLlm || !config) {
    return { ok: true, source: det ? 'deterministic' : 'skipped' }
  }

  try {
    const llm = await verifyCartChangeWithLlm({
      config,
      oldItems,
      newItems,
      customerText,
      operation,
      actionsSummary,
      recentCustomerMsgs,
      useSinglish,
    })
    return llm
  } catch (err) {
    console.warn('[sales-agent] cart change LLM verify failed:', err)
    // Don't block send on verify outage if deterministic passed
    return { ok: true, source: 'deterministic' }
  }
}

async function verifyCartChangeWithLlm(args: {
  config: AiConfig
  oldItems: CartLineSnapshot[]
  newItems: CartLineSnapshot[]
  customerText: string
  operation: CartOperation
  actionsSummary?: string
  recentCustomerMsgs: string[]
  useSinglish: boolean
}): Promise<CartChangeVerifyResult> {
  const system = `You verify WhatsApp bag cart/order edits for ladiesbags.lk.
Compare OLD cart, NEW cart, and the customer's request.
Return JSON only: {"ok":true|false,"reason":"short"}
ok=true only if NEW correctly applies the customer request to OLD (no doubled qty, no wrong bag, no missing keep-lines, color swap / remove+add applied).
ok=false if NEW looks wrong vs the request.`

  const recent =
    args.recentCustomerMsgs.filter(Boolean).slice(-4).join('\n---\n') || '(none)'

  const user = `CUSTOMER REQUEST (latest):
${args.customerText.trim()}

RECENT CUSTOMER MSGS:
${recent}

ACTIONS: ${args.actionsSummary || args.operation || 'unknown'}

OLD CART:
${formatLines(args.oldItems)}

NEW CART (proposed — do NOT send if wrong):
${formatLines(args.newItems)}

Does NEW correctly match the customer request applied to OLD?`

  const raw = await callVerifyModel(args.config, system, [
    { role: 'user', content: user },
  ])
  const parsed = parseVerifyJson(raw)
  if (!parsed) {
    return { ok: true, source: 'llm' }
  }
  if (parsed.ok) return { ok: true, source: 'llm' }

  const reason = parsed.reason || 'verify_failed'
  return {
    ok: false,
    source: 'llm',
    reason,
    message: args.useSinglish
      ? `Order/quote change eka confirm karanna — mama check kala: ${reason}. Hariyata bags + colors + qty kiyanna.`
      : `Please confirm the change — check failed: ${reason}. Tell bag, color, and qty again.`,
  }
}

function parseVerifyJson(raw: string): { ok: boolean; reason?: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1].trim() : trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>
    if (typeof obj.ok !== 'boolean') return null
    return {
      ok: obj.ok,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : undefined,
    }
  } catch {
    return null
  }
}

async function callVerifyModel(
  config: AiConfig,
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<string> {
  const timeoutMs = Math.min(aiRequestTimeoutMs(), 20_000)
  const url =
    config.provider === 'openrouter'
      ? OPENROUTER_URL
      : config.provider === 'gemini'
        ? GEMINI_OPENAI_URL
        : config.provider === 'anthropic'
          ? null
          : OPENAI_URL
  if (!url || config.provider === 'anthropic') return ''

  const apiMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]

  const callOnce = async (
    model: string,
    apiKey: string,
    withFallbacks: boolean,
  ): Promise<string> => {
    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      temperature: 0,
    }
    if (config.provider === 'openrouter') {
      body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, 200)
      body.provider = openRouterProviderPreferences(model)
      if (withFallbacks) {
        const fallbacks = openRouterFallbackModels(model)
        if (fallbacks.length) body.models = fallbacks
      }
      body.response_format = { type: 'json_object' }
    } else if (config.provider === 'gemini') {
      body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, 200)
    } else {
      body.max_completion_tokens = Math.min(MAX_OUTPUT_TOKENS, 200)
      body.response_format = { type: 'json_object' }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(config.provider === 'openrouter'
          ? {
              'HTTP-Referer': 'https://ladiesbags.lk',
              'X-Title': 'LadiesBags Cart Verify',
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`verify HTTP ${res.status}: ${errText.slice(0, 120)}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return String(data.choices?.[0]?.message?.content || '')
  }

  if (config.provider === 'gemini') {
    const attempts = buildGeminiAttempts(config)
    let lastErr: unknown
    for (const attempt of attempts) {
      try {
        return await callOnce(attempt.model, attempt.apiKey, false)
      } catch (err) {
        lastErr = err
        if (!shouldRetryGeminiAttempt(err)) break
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  const primaryKey = config.apiKey || ''
  const primaryModel = config.model || ''
  try {
    return await callOnce(primaryModel, primaryKey, true)
  } catch (err) {
    if (
      config.provider === 'openrouter' &&
      (isOpenRouterRateLimitError(err) || isOpenRouterPrivacyError(err))
    ) {
      for (const m of openRouterClientRetryModels(primaryModel)) {
        try {
          return await callOnce(m, primaryKey, true)
        } catch {
          /* try next */
        }
      }
      if (shouldSuggestOpenRouterZdrFallback(primaryModel)) {
        try {
          return await callOnce(OPENROUTER_ZDR_FALLBACK_MODEL, primaryKey, false)
        } catch {
          /* fall through */
        }
      }
    }
    throw err
  }
}
