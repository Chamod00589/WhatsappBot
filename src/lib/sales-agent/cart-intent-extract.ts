import type { AiConfig, AiUsage, ChatMessage } from '@/lib/ai/types'
import { AiError } from '@/lib/ai/types'
import {
  aiRequestTimeoutMs,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/defaults'
import { mergeConsecutive, normalizeUsage } from '@/lib/ai/providers/shared'
import {
  OPENROUTER_ZDR_FALLBACK_MODEL,
  isOpenRouterPrivacyError,
  isOpenRouterRateLimitError,
  openRouterClientRetryModels,
  openRouterFallbackModels,
  openRouterProviderPreferences,
  shouldSuggestOpenRouterZdrFallback,
} from '@/lib/ai/providers/openrouter-routing'
import {
  GEMINI_OPENAI_URL,
  buildGeminiAttempts,
  shouldRetryGeminiAttempt,
} from '@/lib/ai/providers/gemini'
import type { MatchableQuickReply } from './match-products'
import { productDisplayName } from './order-intent'
import { normalizeMatchText } from './normalize'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type CartIntentKind = 'quotation' | 'edit_cart' | 'none'

/** @deprecated Prefer CartActionType via actions[]. Kept for verify/logging compat. */
export type CartOperation =
  | 'set'
  | 'add'
  | 'add_qty'
  | 'replace_qty'
  | 'remove'
  | null

/** Ordered cart edits — server applies these left-to-right, no coercion. */
export type CartActionType = 'set' | 'add' | 'remove' | 'set_qty' | 'add_qty'

export type CartAction = {
  type: CartActionType
  productId: string | null
  name: string | null
  /** Customer words (fallback if name/productId missing). */
  mentioned: string
  qty: number | null
  /** Exact catalog color, or null when not stated / color-only remove by name. */
  color: string | null
  confidence: number
}

export type CartExtractedItem = {
  productId: string | null
  name: string | null
  mentioned: string
  qty: number | null
  color: string | null
  confidence: number
}

export type CartIntentExtraction = {
  intent: CartIntentKind
  /** Ordered edits — source of truth for the pipeline. */
  actions: CartAction[]
  /**
   * Derived from actions (or legacy LLM fields) for logging / verify.
   * @deprecated Do not branch apply logic on this.
   */
  operation: CartOperation
  /** Derived: item-shaped rows from add/set/set_qty/add_qty actions. */
  items: CartExtractedItem[]
  /** Derived: first remove action match, when present. */
  target: { mentioned: string | null; color: string | null }
}

export type CartExtractResult = {
  extraction: CartIntentExtraction
  usage: AiUsage | null
  raw: string
}

const EMPTY_EXTRACTION: CartIntentExtraction = {
  intent: 'none',
  actions: [],
  operation: null,
  items: [],
  target: { mentioned: null, color: null },
}

/** Format the full bag catalog for the extract prompt. */
export function formatCatalogForExtract(
  catalog: MatchableQuickReply[],
  limit = 80,
): string {
  const lines: string[] = []
  for (const q of catalog.slice(0, limit)) {
    const name =
      (q.bagName || productDisplayName(q.title) || q.title).trim() || q.title
    const pid = q.product_id || ''
    if (!pid && !name) continue
    const price =
      typeof q.retailPrice === 'number' && q.retailPrice > 0
        ? `Rs ${q.retailPrice}`
        : 'price n/a'
    const colors =
      q.colors && q.colors.length ? q.colors.join(', ') : 'colors n/a'
    lines.push(
      `- productId=${pid || '?'} | name=${name} | price=${price} | colors=[${colors}]`,
    )
  }
  return lines.join('\n')
}

function buildExtractSystemPrompt(catalogBlock: string): string {
  return `You are a cart parser for Ladies Bags WhatsApp (Singlish/Tanglish/English).
You are given the FULL product catalog below. When the customer asks for bag(s), SELECT only from that list.

Return ONLY valid JSON (no markdown):
{
  "intent": "quotation" | "edit_cart" | "none",
  "actions": [
    {
      "type": "set" | "add" | "remove" | "set_qty" | "add_qty",
      "productId": "exact productId from catalog (or null for color-only remove)",
      "name": "exact name from catalog (or null)",
      "mentioned": "customer words for this edit",
      "qty": number | null,
      "color": "exact color from that product's colors list, or null",
      "confidence": 0-1
    }
  ]
}

Rules:
- ALWAYS pick productId + name from the CATALOG LIST. Never invent bags not on the list.
- color MUST be copied exactly from that product's colors=[...] when the customer stated a color. If they did not say a color, use null (server will ask).
- qty = how many pieces. Singlish: dekak=2, thunak=3, "2k"/"2i"=2, "1kui"=1, "ekak"=1. Default qty=1 when they want the bag but gave no count.
- Keep each bag/color as a SEPARATE action — do NOT merge. Same bag in two colors = two actions.
- confidence = how sure the catalog match is (0-1). Use ≥0.9 when productId is clear.

intent:
- quotation = ask price / kochchara / quote / want bags to buy (new selection).
- edit_cart = add/remove/change qty/color on SELECTED BAGS or CURRENT LIVE ORDER in Session state.
- none = FAQ, delivery, greetings, address-only, OR only asking photos/colors/details of a bag (server sends product card — do NOT quote).
- Example: "Cloudy bag eketh photos ewanawada" → intent=none.

actions (CRITICAL — server executes these IN ORDER with no guessing):
- set = put this line into a NEW cart (quotation / replace whole selection). List every bag they want as separate set actions. Photo/"this bag" must be included when Session lists PHOTO IDENTIFIED bags.
- add = ADD this bag/color onto the existing cart ("ekakuth", "thawa pink 1k", "me bag ekath denna", "brown 3k ekathukaranna"). qty = pieces to ADD.
- remove = DROP matching bag/color from cart ("white eka epa", "ain karanna", "nathiwa"). Match by color and/or productId from Session selected bags / live order.
- set_qty = SET absolute qty on an existing line ("Pink bag 2i oni", "qty eka 2") — NOT add. Use when they restate how many they want total for that line.
- add_qty = increase qty by N on an existing line ("thawa ekak", "one more") without naming a final total.

Compound edits = MULTIPLE actions in order. Never collapse into one operation.
- "White color eka epa. Eka ain karala brown 3k ekathukaranna" with Cloudy White in cart →
  [{"type":"remove","color":"White","productId":"<cloudy id>","mentioned":"White color eka",...},{"type":"add","color":"Brown","qty":3,"productId":"<cloudy id>",...}]
- "white eken oni, brown ain karanna" on live order with Brown →
  [{"type":"remove","color":"Brown",...},{"type":"add","color":"White","qty":1,...}]
  (or set_qty/recolor via remove+add — never invent a swap op)
- Photo Mini Black + "this bag and puff Pink 2" → two set actions: Mini Black qty1 + Puff Pink qty2.
- Cart has Pink qty2; "Pink bag 2i oni" → one set_qty action qty=2 (NOT add).
- Swipe-reply "Me bag ekath denna" → one add action for that bag qty1 only (do NOT re-list the whole cart).

Never invent productIds or colors not listed for that product.
When Session lists SELECTED BAGS or CURRENT LIVE ORDER, use those productIds/colors for edit/remove/set_qty.

CATALOG (select ONLY from here):
${catalogBlock || '(empty catalog)'}
`
}

function parseActionRow(row: Record<string, unknown>): CartAction | null {
  const typeRaw = String(row.type || row.action || '').toLowerCase()
  const type: CartActionType | null =
    typeRaw === 'set' ||
    typeRaw === 'add' ||
    typeRaw === 'remove' ||
    typeRaw === 'set_qty' ||
    typeRaw === 'add_qty' ||
    typeRaw === 'replace_qty'
      ? typeRaw === 'replace_qty'
        ? 'set_qty'
        : (typeRaw as CartActionType)
      : null
  if (!type) return null

  const productId =
    typeof row.productId === 'string' && row.productId.trim()
      ? row.productId.trim()
      : typeof row.product_id === 'string' && row.product_id.trim()
        ? row.product_id.trim()
        : null
  const name =
    typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
  const mentioned =
    typeof row.mentioned === 'string' && row.mentioned.trim()
      ? row.mentioned.trim()
      : name || productId || (typeof row.color === 'string' ? row.color : '') || ''
  const qtyNum = Number(row.qty)
  const qty =
    row.qty == null || row.qty === ''
      ? null
      : Number.isFinite(qtyNum) && qtyNum > 0
        ? Math.floor(qtyNum)
        : null
  const color =
    typeof row.color === 'string' && row.color.trim() ? row.color.trim() : null
  let confidence = Number(row.confidence)
  if (!Number.isFinite(confidence)) {
    confidence = productId || name || color ? 0.95 : 0.5
  }
  confidence = Math.max(0, Math.min(1, confidence))

  // remove may be color-only; other types need some identity
  if (type !== 'remove' && !mentioned && !productId && !name) return null
  if (type === 'remove' && !color && !productId && !name && !mentioned) return null

  return {
    type,
    productId,
    name,
    mentioned: mentioned || name || productId || color || '',
    qty,
    color,
    confidence,
  }
}

function parseItemRow(row: Record<string, unknown>): CartExtractedItem | null {
  const productId =
    typeof row.productId === 'string' && row.productId.trim()
      ? row.productId.trim()
      : typeof row.product_id === 'string' && row.product_id.trim()
        ? row.product_id.trim()
        : null
  const name =
    typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
  const mentioned =
    typeof row.mentioned === 'string' && row.mentioned.trim()
      ? row.mentioned.trim()
      : name || productId || ''
  if (!mentioned && !productId && !name) return null
  const qtyNum = Number(row.qty)
  const qty =
    row.qty == null || row.qty === ''
      ? null
      : Number.isFinite(qtyNum) && qtyNum > 0
        ? Math.floor(qtyNum)
        : null
  const color =
    typeof row.color === 'string' && row.color.trim() ? row.color.trim() : null
  let confidence = Number(row.confidence)
  if (!Number.isFinite(confidence)) {
    confidence = productId || name ? 0.95 : 0.5
  }
  confidence = Math.max(0, Math.min(1, confidence))
  return {
    productId,
    name,
    mentioned: mentioned || name || productId || '',
    qty,
    color,
    confidence,
  }
}

function itemToAction(
  type: CartActionType,
  item: CartExtractedItem,
): CartAction {
  return {
    type,
    productId: item.productId,
    name: item.name,
    mentioned: item.mentioned,
    qty: item.qty,
    color: item.color,
    confidence: item.confidence,
  }
}

/**
 * Convert legacy operation+items+target into ordered actions.
 * Special case: add + target color + items in a different color → remove then add
 * (the failure mode of "white epa + brown 3k").
 */
export function legacyFieldsToActions(args: {
  operation: CartOperation
  items: CartExtractedItem[]
  target: { mentioned: string | null; color: string | null }
  intent: CartIntentKind
}): CartAction[] {
  const { operation, items, target, intent } = args
  if (!operation && !items.length) return []

  const op =
    operation ||
    (intent === 'edit_cart' ? 'add' : intent === 'quotation' ? 'set' : null)
  if (!op) return []

  const targetColor = target.color?.trim() || null
  const targetMention = target.mentioned?.trim() || null

  // Compound: remove target color, then add the new lines
  if (
    (op === 'add' || op === 'set') &&
    targetColor &&
    items.some((it) => {
      const c = it.color?.trim()
      return c && normalizeMatchText(c) !== normalizeMatchText(targetColor)
    })
  ) {
    const actions: CartAction[] = [
      {
        type: 'remove',
        productId: null,
        name: null,
        mentioned: targetMention || targetColor,
        qty: null,
        color: targetColor,
        confidence: 0.95,
      },
    ]
    for (const it of items) {
      actions.push(itemToAction('add', it))
    }
    return actions
  }

  if (op === 'remove') {
    if (items.length) {
      return items.map((it) =>
        itemToAction('remove', {
          ...it,
          color: it.color || targetColor,
        }),
      )
    }
    return [
      {
        type: 'remove',
        productId: null,
        name: null,
        mentioned: targetMention || targetColor || '',
        qty: null,
        color: targetColor,
        confidence: 0.95,
      },
    ]
  }

  if (op === 'replace_qty') {
    return items.map((it) => itemToAction('set_qty', it))
  }
  if (op === 'add_qty') {
    return items.map((it) => itemToAction('add_qty', it))
  }
  if (op === 'add') {
    return items.map((it) => itemToAction('add', it))
  }
  // set
  return items.map((it) => itemToAction('set', it))
}

/** Derive deprecated operation/items/target from actions for logging + verify. */
export function deriveCompatFromActions(
  actions: CartAction[],
): Pick<CartIntentExtraction, 'operation' | 'items' | 'target'> {
  if (!actions.length) {
    return {
      operation: null,
      items: [],
      target: { mentioned: null, color: null },
    }
  }

  const types = new Set(actions.map((a) => a.type))
  let operation: CartOperation = null
  if (types.size === 1) {
    const only = actions[0].type
    operation =
      only === 'set_qty'
        ? 'replace_qty'
        : only === 'add_qty'
          ? 'add_qty'
          : only === 'set'
            ? 'set'
            : only === 'add'
              ? 'add'
              : only === 'remove'
                ? 'remove'
                : null
  } else if (types.has('remove') && (types.has('add') || types.has('set'))) {
    operation = 'set' // compound → full cart replace semantics downstream
  } else if (types.has('set')) {
    operation = 'set'
  } else if (types.has('add')) {
    operation = 'add'
  } else if (types.has('remove')) {
    operation = 'remove'
  }

  const items: CartExtractedItem[] = actions
    .filter((a) => a.type !== 'remove')
    .map((a) => ({
      productId: a.productId,
      name: a.name,
      mentioned: a.mentioned,
      qty: a.qty,
      color: a.color,
      confidence: a.confidence,
    }))

  const remove = actions.find((a) => a.type === 'remove')
  const target = {
    mentioned: remove?.mentioned || null,
    color: remove?.color || null,
  }

  return { operation, items, target }
}

function finalizeExtraction(
  intent: CartIntentKind,
  actions: CartAction[],
): CartIntentExtraction {
  const compat = deriveCompatFromActions(actions)
  return { intent, actions, ...compat }
}

/**
 * Parse model JSON into a safe CartIntentExtraction (for tests + live path).
 * Prefers actions[]; falls back to legacy operation+items+target.
 */
export function parseCartIntentJson(raw: unknown): CartIntentExtraction {
  let obj: Record<string, unknown> | null = null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const body = fence ? fence[1].trim() : trimmed
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start < 0 || end <= start) return { ...EMPTY_EXTRACTION }
    try {
      obj = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>
    } catch {
      return { ...EMPTY_EXTRACTION }
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return { ...EMPTY_EXTRACTION }

  const intentRaw = String(obj.intent || 'none').toLowerCase()
  const intent: CartIntentKind =
    intentRaw === 'quotation' || intentRaw === 'edit_cart' ? intentRaw : 'none'

  // Nested edits[] / actions[] (new schema)
  const actionsRaw = Array.isArray(obj.actions)
    ? obj.actions
    : Array.isArray(obj.edits)
      ? obj.edits
      : null

  if (actionsRaw && actionsRaw.length) {
    const actions: CartAction[] = []
    for (const rawAct of actionsRaw) {
      if (!rawAct || typeof rawAct !== 'object') continue
      const row = rawAct as Record<string, unknown>
      // Support { action, match, item } shape
      if (row.match && typeof row.match === 'object') {
        const match = row.match as Record<string, unknown>
        const item =
          row.item && typeof row.item === 'object'
            ? (row.item as Record<string, unknown>)
            : {}
        const merged = { ...match, ...item, type: row.type || row.action }
        const parsed = parseActionRow(merged)
        if (parsed) actions.push(parsed)
        continue
      }
      const parsed = parseActionRow(row)
      if (parsed) actions.push(parsed)
    }
    if (actions.length) return finalizeExtraction(intent, actions)
  }

  // Legacy operation + items + target
  const opRaw = obj.operation == null ? null : String(obj.operation).toLowerCase()
  const operation: CartOperation =
    opRaw === 'set' ||
    opRaw === 'add' ||
    opRaw === 'add_qty' ||
    opRaw === 'replace_qty' ||
    opRaw === 'remove'
      ? opRaw
      : null

  const itemsRaw = Array.isArray(obj.items) ? obj.items : []
  const items: CartExtractedItem[] = []
  for (const it of itemsRaw) {
    if (!it || typeof it !== 'object') continue
    const parsed = parseItemRow(it as Record<string, unknown>)
    if (parsed) items.push(parsed)
  }

  const targetObj =
    obj.target && typeof obj.target === 'object'
      ? (obj.target as Record<string, unknown>)
      : {}
  const target = {
    mentioned:
      typeof targetObj.mentioned === 'string' && targetObj.mentioned.trim()
        ? targetObj.mentioned.trim()
        : null,
    color:
      typeof targetObj.color === 'string' && targetObj.color.trim()
        ? targetObj.color.trim()
        : null,
  }

  const actions = legacyFieldsToActions({
    operation,
    items,
    target,
    intent,
  })
  return finalizeExtraction(intent, actions)
}

/**
 * LLM selects bags from the provided catalog list (name/qty/color/productId).
 * Server still validates colors and fills quote prices from DB.
 */
export async function extractCartIntent(args: {
  config: AiConfig
  messages: ChatMessage[]
  burstText: string
  sessionExtra?: string
  productCatalog?: MatchableQuickReply[]
}): Promise<CartExtractResult> {
  const { config, burstText } = args
  if (!burstText.trim()) {
    return { extraction: { ...EMPTY_EXTRACTION }, usage: null, raw: '' }
  }

  const catalogBlock = formatCatalogForExtract(args.productCatalog || [])
  const systemPrompt = buildExtractSystemPrompt(catalogBlock)

  const userContent = [
    args.sessionExtra?.trim()
      ? `Current order / session state:\n${args.sessionExtra.trim()}`
      : '',
    `Latest customer message(s):\n${burstText.trim()}`,
    'Select matching bags from the catalog in the system prompt. Return JSON only with ordered actions[].',
  ]
    .filter(Boolean)
    .join('\n\n')

  const messages: ChatMessage[] = [
    ...args.messages.slice(-8),
    { role: 'user', content: userContent },
  ]

  const { text, usage } = await callJsonModel(config, systemPrompt, messages)
  return {
    extraction: parseCartIntentJson(text),
    usage,
    raw: text,
  }
}

async function callJsonModel(
  config: AiConfig,
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<{ text: string; usage: AiUsage | null }> {
  const timeoutMs = aiRequestTimeoutMs()
  const url =
    config.provider === 'openrouter'
      ? OPENROUTER_URL
      : config.provider === 'gemini'
        ? GEMINI_OPENAI_URL
        : config.provider === 'anthropic'
          ? null
          : OPENAI_URL

  if (config.provider === 'anthropic' || !url) {
    return { text: '', usage: null }
  }

  const apiMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...mergeConsecutive(messages).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]

  const callOnce = async (
    model: string,
    apiKey: string,
    withFallbacks: boolean,
  ): Promise<{ text: string; usage: AiUsage | null }> => {
    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      temperature: 0,
    }
    if (config.provider === 'openrouter') {
      body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, 800)
      body.provider = openRouterProviderPreferences(model)
      if (withFallbacks) {
        const fallbacks = openRouterFallbackModels(model)
        if (fallbacks.length) body.models = fallbacks
      }
      body.response_format = { type: 'json_object' }
    } else if (config.provider === 'gemini') {
      body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, 800)
    } else {
      body.max_completion_tokens = Math.min(MAX_OUTPUT_TOKENS, 800)
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
              'X-Title': 'LadiesBags Sales Agent Extract',
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new AiError(`Cart extract HTTP ${res.status}: ${errText.slice(0, 200)}`, {
        code: res.status === 401 ? 'invalid_key' : 'provider_error',
        status: res.status,
      })
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
    }
    const text = data.choices?.[0]?.message?.content?.trim() || ''
    const usageRaw = data.usage
    const usage = usageRaw
      ? normalizeUsage({
          prompt: usageRaw.prompt_tokens,
          completion: usageRaw.completion_tokens,
          total: usageRaw.total_tokens,
        })
      : null
    return { text, usage }
  }

  if (config.provider === 'gemini') {
    const attempts = buildGeminiAttempts({
      apiKey: config.apiKey,
      apiKey2: config.apiKey2,
      preferredModel: config.model,
    })
    let lastErr: unknown = null
    for (const attempt of attempts) {
      try {
        return await callOnce(attempt.model, attempt.apiKey, false)
      } catch (err) {
        lastErr = err
        if (!shouldRetryGeminiAttempt(err)) throw err
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new AiError('Cart extract failed', { code: 'provider_error', status: 500 })
  }

  try {
    return await callOnce(config.model, config.apiKey, true)
  } catch (err) {
    if (
      config.provider === 'openrouter' &&
      isOpenRouterPrivacyError(err) &&
      shouldSuggestOpenRouterZdrFallback(config.model)
    ) {
      try {
        return await callOnce(OPENROUTER_ZDR_FALLBACK_MODEL, config.apiKey, true)
      } catch (zdrErr) {
        if (!isOpenRouterRateLimitError(zdrErr)) throw zdrErr
        err = zdrErr
      }
    }
    if (
      config.provider === 'openrouter' &&
      isOpenRouterRateLimitError(err)
    ) {
      for (const next of openRouterClientRetryModels(config.model)) {
        try {
          return await callOnce(next, config.apiKey, false)
        } catch {
          /* try next */
        }
      }
    }
    throw err
  }
}
