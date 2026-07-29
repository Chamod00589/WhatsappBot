/**
 * OpenRouter routing helpers for accounts with Zero Data Retention (ZDR)
 * / privacy guardrails enabled.
 *
 * With OpenAI ZDR on, first-party OpenAI is blocked — only Azure serves
 * openai/* models. Google ZDR blocks AI Studio; Vertex/"Google" ZDR
 * endpoints remain. See https://openrouter.ai/docs/guides/features/zdr
 */

/** Cheap chat model known to appear on OpenRouter's ZDR endpoint list. */
export const OPENROUTER_ZDR_FALLBACK_MODEL = 'google/gemini-2.5-flash'

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
