import type { ProviderResult } from '../types'
import type { ProviderArgs } from './shared'
import { generateOpenAiCompatible } from './openai-compatible'
import { isOpenRouterRateLimitError } from './openrouter-routing'

/**
 * Google Gemini via the OpenAI-compatible Chat Completions endpoint.
 * Same tool-calling shape as OpenAI, so Sales Agent works unchanged.
 * https://ai.google.dev/gemini-api/docs/openai
 */
export const GEMINI_OPENAI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'

/**
 * Free-tier friendly cascade (mirrors ladies-bags-v2 /api/gemini).
 * Tried in order when the primary hits 429 / quota.
 */
export const GEMINI_DEFAULT_FALLBACK_MODELS: readonly string[] = [
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
]

export function geminiFallbackModels(primaryModel: string): string[] {
  const primary = primaryModel.trim().toLowerCase()
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of GEMINI_DEFAULT_FALLBACK_MODELS) {
    const key = id.toLowerCase()
    if (!key || key === primary || seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

/**
 * Call Gemini with the caller's Google AI Studio key.
 * On rate/quota limits, walks {@link GEMINI_DEFAULT_FALLBACK_MODELS}.
 */
export async function generateGemini(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const call = (model: string) =>
    generateOpenAiCompatible(
      { ...args, model },
      {
        url: GEMINI_OPENAI_URL,
        providerLabel: 'Gemini',
        maxTokensField: 'max_tokens',
      },
    )

  try {
    return await call(args.model)
  } catch (err) {
    if (!isOpenRouterRateLimitError(err)) throw err
    for (const next of geminiFallbackModels(args.model)) {
      console.warn(
        `[gemini] rate/quota on "${args.model}" — retrying with ${next}`,
      )
      try {
        return await call(next)
      } catch (nextErr) {
        if (isOpenRouterRateLimitError(nextErr)) continue
        throw nextErr
      }
    }
    throw err
  }
}
