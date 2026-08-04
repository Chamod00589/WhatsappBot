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
  mentioned: string
  qty: number | null
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

const EXTRACT_SYSTEM = `You extract shopping-cart intent from WhatsApp bag customers (Singlish/Tanglish/English).
Return ONLY valid JSON (no markdown) matching:
{
  "intent": "quotation" | "edit_cart" | "none",
  "operation": "set" | "add" | "add_qty" | "replace_qty" | "remove" | null,
  "items": [
    { "mentioned": "customer words for the bag", "qty": number|null, "color": string|null, "confidence": 0-1 }
  ],
  "target": { "mentioned": string|null, "color": string|null }
}

Rules:
- Extract ONLY what the customer said. Never invent catalog product names, product IDs, or prices.
- Keep each bag as a separate items[] entry — do NOT merge lines (server merges).
- mentioned = the customer's words (e.g. "mini bag", "cloudy", "meka").
- color = Latin or Singlish color word if stated, else null. Do not invent colors.
- qty = explicit count if stated (dekak=2, thunak=3, "2k"=2), else null.
- confidence = how sure you are they mean a specific bag mention (0-1).
- intent=quotation when they ask price / kochchara / quote / want bags with prices.
- intent=edit_cart when they add/remove/change qty/color on an existing cart ("thawa dekak", "eka ain", "2 wenna").
- intent=none for FAQ, delivery time, greetings, address-only, or unrelated chat.
- operation:
  - set = new cart / replace listing of bags
  - add = add new bag line(s)
  - add_qty = increase qty on last/target bag ("thawa dekak")
  - replace_qty = set qty on last/target ("2 wenna")
  - remove = remove a bag ("eka ain karanna")
  - null when intent is none or unclear
- target.mentioned / target.color = which existing line to edit when operation is add_qty/replace_qty/remove and they named one.
- Never output prices or product IDs.`

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
    const mentioned = typeof row.mentioned === 'string' ? row.mentioned.trim() : ''
    if (!mentioned) continue
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
    if (!Number.isFinite(confidence)) confidence = 0.5
    confidence = Math.max(0, Math.min(1, confidence))
    items.push({ mentioned, qty, color, confidence })
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
 * LLM JSON-only cart intent extraction. Does not decide products or prices.
 */
export async function extractCartIntent(args: {
  config: AiConfig
  messages: ChatMessage[]
  burstText: string
  sessionExtra?: string
}): Promise<CartExtractResult> {
  const { config, burstText } = args
  if (!burstText.trim()) {
    return { extraction: { ...EMPTY_EXTRACTION }, usage: null, raw: '' }
  }

  const userContent = [
    args.sessionExtra?.trim()
      ? `Current order state:\n${args.sessionExtra.trim()}`
      : '',
    `Latest customer message(s):\n${burstText.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const messages: ChatMessage[] = [
    ...args.messages.slice(-8),
    { role: 'user', content: userContent },
  ]

  const { text, usage } = await callJsonModel(config, EXTRACT_SYSTEM, messages)
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
    // Anthropic tool-loop uses a different path; for extract use OpenAI-compat if key looks usable,
    // otherwise return empty so dispatch falls through to FAQ tools.
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
      body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, 512)
      body.provider = openRouterProviderPreferences(model)
      if (withFallbacks) {
        const fallbacks = openRouterFallbackModels(model)
        if (fallbacks.length) body.models = fallbacks
      }
      body.response_format = { type: 'json_object' }
    } else if (config.provider === 'gemini') {
      body.max_tokens = Math.min(MAX_OUTPUT_TOKENS, 512)
    } else {
      body.max_completion_tokens = Math.min(MAX_OUTPUT_TOKENS, 512)
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
