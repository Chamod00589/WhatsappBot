import { describe, expect, it } from 'vitest'
import {
  OPENROUTER_DEFAULT_FALLBACK_MODELS,
  isOpenRouterRateLimitError,
  openRouterFallbackModels,
} from './openrouter-routing'

describe('openRouterFallbackModels', () => {
  it('excludes the primary model from fallbacks', () => {
    const list = openRouterFallbackModels('google/gemini-2.5-flash-lite')
    expect(list.map((m) => m.toLowerCase())).not.toContain(
      'google/gemini-2.5-flash-lite',
    )
    expect(list.length).toBeGreaterThan(0)
  })

  it('keeps defaults when primary is gemini-2.5-flash', () => {
    const list = openRouterFallbackModels('google/gemini-2.5-flash')
    expect(list[0]).toBe(OPENROUTER_DEFAULT_FALLBACK_MODELS[0])
  })

  it('caps models array at 3 (OpenRouter limit)', () => {
    const list = openRouterFallbackModels('google/gemini-2.5-flash')
    expect(list.length).toBeLessThanOrEqual(3)
  })
})

describe('isOpenRouterRateLimitError', () => {
  it('matches rate_limited code', () => {
    expect(isOpenRouterRateLimitError({ code: 'rate_limited' })).toBe(true)
  })

  it('matches quota wording', () => {
    expect(
      isOpenRouterRateLimitError({
        message: 'Rate limit exceeded: free-models-per-day',
      }),
    ).toBe(true)
  })
})
