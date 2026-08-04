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

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export type CartIntentKind = 'quotation' | 'edit_cart' | 'none'
export type CartOperation =
  | 'set'
  | 'add'
  | 'add_qty'
  | 'replace_qty'
  | 'remove'
  | null

export type CartExtractedItem = {
  /** Exact catalog product id when the model selected from the list. */
  productId: string | null
  /** Exact catalog name when selected from the list (preferred). */
  name: string | null
  /** Customer's words (fallback if name/productId missing). */
  mentioned: string
  qty: number | null
  /** Must be one of that product's colors from the catalog list, or null. */
  color: string | null
  confidence: number
}

export type CartIntentExtraction = {
  intent: CartIntentKind
  operation: CartOperation
  items: CartExtractedItem[]
  target: { mentioned: string | null; color: string | null }
}

export type CartExtractResult = {
  extraction: CartIntentExtraction
  usage: AiUsage | null
  raw: string
}

const EMPTY_EXTRACTION: CartIntentExtraction = {
  intent: 'none',
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
  "operation": "set" | "add" | "add_qty" | "replace_qty" | "remove" | null,
  "items": [
    {
      "productId": "exact productId from catalog",
      "name": "exact name from catalog",
      "mentioned": "customer words that matched this bag",
      "qty": number,
      "color": "exact color spelling from that product's colors list, or null",
      "confidence": 0-1
    }
  ],
  "target": { "mentioned": string|null, "color": string|null }
}

Rules:
- ALWAYS pick productId + name from the CATALOG LIST. Never invent bags not on the list.
- color MUST be copied exactly from that product's colors=[...] when the customer stated a color. If they did not say a color, use null (server will ask).
- When Session state lists PHOTO IDENTIFIED bag(s), "this bag" / "that bag" / "me bag" / "meka" / "meke" means THAT photo product — include it as an items[] row (use the identified productId/name/color). Do NOT drop the photo bag when they also name another bag.
- Example: photo = Mini Shoulder Bag (Black) + text "Can i buy this bag and puff Pink 2 bags" → TWO items: Mini Black qty 1 + Puff Pink qty 2.
- qty = how many pieces they want. Understand Singlish freely (dekak=2, thunak=3, "2k"/"2i"=2, "1kui"=1, "ekak"=1). Default qty=1 when they want the bag but gave no count.
- Keep each bag/color as a SEPARATE items[] row — do NOT merge. Same bag in two colors = two items.
- Example: "Cloudy white 2i black 1k" → two items: Cloudy White qty 2 + Cloudy Black qty 1 (same productId, different colors).
- confidence = how sure the catalog match is (0-1). Use ≥0.9 when productId is clear.
- intent=quotation when they ask price / kochchara / quote / want bags to buy.
- intent=edit_cart when they add/remove/change qty/color on an existing cart OR on CURRENT LIVE ORDER lines listed in Session state. Prefer productId/name/color from those selected bags / live order lines — never invent bags from unrelated screenshots.
- intent=none for FAQ, delivery time, greetings, address-only, unrelated chat, OR when they only ask for photos / colors / details / info of a bag (server sends the product card — do NOT quote).
- Example: "Cloudy bag eketh photos ewanawada" → intent=none (photos ask).
- Example: Session has CURRENT LIVE ORDER Cloudy Brown x1 + Bloom White x2; customer "white eken oni, brown ain karanna" → intent=edit_cart, remove Brown (or recolor that line to White), keep other lines — use live order productIds.
- Color replace (critical): "White color eka epa. Eka ain karala brown 3k ekathukaranna" with cart Cloudy White x1 → intent=edit_cart, operation=add, items=[{Cloudy, Brown, qty:3}], target={color:"White"} (server removes White then upserts Brown×3). Do NOT use replace_qty (that keeps White and only changes qty).
- operation meanings (critical — wrong op doubles qty):
  - set = new quote / replace whole cart with items[]
  - add = ADD extra bags ("white bag ekakuth", "thawa pink 1k", "me bag ekath denna", "another black"). qty = pieces to ADD (default 1), NOT a new cart total. Also used with target=color-to-remove for color replace.
  - add_qty = increase qty by N ("thawa ekak", "one more") without stating a final total
  - replace_qty = SET qty to the number they stated for a bag already in cart ("Pink bag 2i oni", "pink 2k denna", "qty eka 2"). Use this when they restate how many they want — NEVER add in that case. NEVER use replace_qty when removing one color and adding another.
  - remove = drop a bag/color from cart or live order (pure remove only — no replacement color)
- Example bug to avoid: cart already has Pink qty 2; customer says "Pink bag 2i oni. Meke 4k thiynawane" → operation=replace_qty, qty=2 (NOT add — add would make 4).
- Example bug to avoid: swipe-reply "Me bag ekath denna" → operation=add, items=[that bag qty 1] only (do NOT list the whole prior cart again).
- Prices in the catalog are for your understanding only — do NOT invent different prices; the server will quote from the database.
- Never invent productIds or colors not listed for that product.
- When Session lists SELECTED BAGS or CURRENT LIVE ORDER, treat those as the customer's current selection for edit/add/remove.

CATALOG (select ONLY from here):
${catalogBlock || '(empty catalog)'}
`
}

/**
 * Parse model JSON into a safe CartIntentExtraction (for tests + live path).
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
    const row = it as Record<string, unknown>
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
    if (!mentioned && !productId && !name) continue
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
    items.push({
      productId,
      name,
      mentioned: mentioned || name || productId || '',
      qty,
      color,
      confidence,
    })
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

  return { intent, operation, items, target }
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
    'Select matching bags from the catalog in the system prompt. Return JSON only.',
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
