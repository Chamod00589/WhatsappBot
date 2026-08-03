/**
 * OpenRouter routing helpers for accounts with Zero Data Retention (ZDR)
 * / privacy guardrails enabled, plus model fallbacks when a primary model
 * (e.g. free Gemini) hits rate / daily limits.
 *
 * With OpenAI ZDR on, first-party OpenAI is blocked — only Azure serves
 * openai/* models. Google ZDR blocks AI Studio; Vertex/"Google" ZDR
 * endpoints remain. See https://openrouter.ai/docs/guides/features/zdr
 *
 * Model fallbacks use OpenRouter's `models` array (tried on rate-limit,
 * downtime, moderation). Docs:
 * https://openrouter.ai/docs/guides/routing/model-fallbacks
 */

/** Cheap chat model known to appear on OpenRouter's ZDR endpoint list. */
export const OPENROUTER_ZDR_FALLBACK_MODEL = 'google/gemini-2.5-flash'

/**
 * Default models to try when the configured primary is rate-limited or
 * unavailable. Prefer cheap Google flashes first (tool-calling friendly),
 * then a free open-weight endpoint. OpenRouter allows at most **3**
 * entries in the `models` fallback array. Override with env
 * `OPENROUTER_FALLBACK_MODELS=model1,model2,model3`
 */
export const OPENROUTER_DEFAULT_FALLBACK_MODELS: readonly string[] = [
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct:free',
]

/** OpenRouter rejects `models` arrays longer than this. */
const OPENROUTER_MODELS_ARRAY_MAX = 3

/**
 * Prefer providers that still serve under common ZDR account settings.
 */
export function openRouterProviderPreferences(
  model: string,
): Record<string, unknown> {
  const m = model.toLowerCase()
  if (m.startsWith('openai/')) {
    // First-party OpenAI is removed when OpenAI ZDR is on; Azure remains.
    return {
      order: ['Azure'],
      allow_fallbacks: true,
    }
  }
  if (m.startsWith('google/') || m.startsWith('gemini')) {
    return {
      order: ['Google', 'Google Vertex'],
      allow_fallbacks: true,
    }
  }
  if (m.startsWith('anthropic/')) {
    return {
      order: ['Amazon Bedrock', 'Google', 'Google Vertex', 'Anthropic'],
      allow_fallbacks: true,
    }
  }
  return { allow_fallbacks: true }
}

export function isOpenRouterPrivacyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  if (e.code === 'openrouter_privacy') return true
  return /guardrail|data policy|privacy|no endpoints available|no model endpoint matches your privacy/i.test(
    e.message || '',
  )
}

export function isOpenRouterRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string; status?: number }
  if (e.code === 'rate_limited') return true
  return /rate.?limit|too many requests|quota|free.?tier|daily.?limit|usage.?limit/i.test(
    e.message || '',
  )
}

/** Models that commonly fail under ZDR when first-party is disabled. */
export function shouldSuggestOpenRouterZdrFallback(model: string): boolean {
  const m = model.toLowerCase().trim()
  if (!m) return true
  if (m === OPENROUTER_ZDR_FALLBACK_MODEL) return false
  // Older Gemini 2.0 Flash IDs are often NOT on the ZDR list.
  if (/gemini-2\.0-flash/.test(m)) return true
  if (m.startsWith('openai/')) return true
  return false
}

function parseEnvFallbackModels(): string[] {
  const raw = process.env.OPENROUTER_FALLBACK_MODELS?.trim()
  if (!raw) return [...OPENROUTER_DEFAULT_FALLBACK_MODELS]
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Build OpenRouter `models` fallback list for a primary model (excludes
 * the primary itself). Passed as the request `models` field so OpenRouter
 * auto-retries on rate-limit / downtime. Capped at 3 (OpenRouter limit).
 */
export function openRouterFallbackModels(primaryModel: string): string[] {
  const primary = primaryModel.trim().toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()

  for (const id of parseEnvFallbackModels()) {
    const key = id.trim().toLowerCase()
    if (!key || key === primary || seen.has(key)) continue
    seen.add(key)
    out.push(id.trim())
    if (out.length >= OPENROUTER_MODELS_ARRAY_MAX) break
  }

  return out
}

/**
 * Ordered list of models to try client-side after the primary fails
 * (rate-limit / quota). Same pool as {@link openRouterFallbackModels},
 * but may include extras from env beyond the OpenRouter `models` cap
 * of 3 — we walk them one request at a time.
 */
export function openRouterClientRetryModels(primaryModel: string): string[] {
  const primary = primaryModel.trim().toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()

  for (const id of parseEnvFallbackModels()) {
    const key = id.trim().toLowerCase()
    if (!key || key === primary || seen.has(key)) continue
    seen.add(key)
    out.push(id.trim())
  }

  return out
}
