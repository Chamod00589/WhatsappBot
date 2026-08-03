import type { ProviderResult } from '../types'
import { AiError } from '../types'
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

/** Newer Flash-Lite (preferred when the key supports it). */
export const GEMINI_MODEL_35_FLASH_LITE = 'gemini-3.5-flash-lite'
/** Stable fallback Flash-Lite. */
export const GEMINI_MODEL_31_FLASH_LITE = 'gemini-3.1-flash-lite'

export interface GeminiAttempt {
  model: string
  apiKey: string
  /** Debug label, e.g. "key2/gemini-3.5-flash-lite". */
  label: string
}

/**
 * Free-tier friendly key×model cascade (spreads quota across projects):
 *   1. key2 + gemini-3.5-flash-lite
 *   2. key1 + gemini-3.1-flash-lite
 *   3. key2 + gemini-3.1-flash-lite
 *
 * key1 + 3.5 is skipped (often fails / exhausted on free tier).
 * If only one key is configured, that key is tried on 3.5 then 3.1.
 */
export function buildGeminiAttempts(args: {
  apiKey: string
  apiKey2?: string | null
  /** Kept for API compatibility; cascade order is fixed for free-tier. */
  preferredModel?: string | null
}): GeminiAttempt[] {
  const key1 = args.apiKey.trim()
  const key2 = args.apiKey2?.trim() || ''

  const out: GeminiAttempt[] = []
  const seen = new Set<string>()
  const push = (model: string, apiKey: string, slot: 'key1' | 'key2') => {
    if (!apiKey || !model) return
    const id = `${slot}|${model}|${apiKey.slice(0, 12)}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({ model, apiKey, label: `${slot}/${model}` })
  }

  if (key2) {
    push(GEMINI_MODEL_35_FLASH_LITE, key2, 'key2')
    push(GEMINI_MODEL_31_FLASH_LITE, key1, 'key1')
    push(GEMINI_MODEL_31_FLASH_LITE, key2, 'key2')
  } else if (key1) {
    push(GEMINI_MODEL_35_FLASH_LITE, key1, 'key1')
    push(GEMINI_MODEL_31_FLASH_LITE, key1, 'key1')
  }

  return out
}

/** Whether to walk to the next Gemini key/model attempt. */
export function shouldRetryGeminiAttempt(err: unknown): boolean {
  if (isOpenRouterRateLimitError(err)) return true
  if (err instanceof AiError) {
    if (err.code === 'rate_limited' || err.code === 'provider_error') return true
    // Wrong key for a model / project mismatch — try the other key.
    if (err.code === 'invalid_key') return true
    return /unavailable|not found|not supported|quota|RESOURCE_EXHAUSTED|INVALID_ARGUMENT|PermissionDenied|403|404|429|400/i.test(
      err.message,
    )
  }
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: string; message?: string }
  if (e.code === 'rate_limited' || e.code === 'provider_error') return true
  return /unavailable|not found|not supported|quota|rate.?limit|RESOURCE_EXHAUSTED|INVALID_ARGUMENT|Permission|403|404|429/i.test(
    e.message || '',
  )
}

/** @deprecated Prefer {@link buildGeminiAttempts}. Kept for older call sites. */
export function geminiFallbackModels(primaryModel: string): string[] {
  const primary = primaryModel.trim().toLowerCase()
  const defaults = [GEMINI_MODEL_35_FLASH_LITE, GEMINI_MODEL_31_FLASH_LITE]
  return defaults.filter((m) => m.toLowerCase() !== primary)
}

/**
 * Call Gemini, walking the key×model cascade on quota / model failures.
 */
export async function generateGemini(
  args: ProviderArgs & { apiKey2?: string | null },
): Promise<ProviderResult> {
  const attempts = buildGeminiAttempts({
    apiKey: args.apiKey,
    apiKey2: args.apiKey2,
    preferredModel: args.model,
  })

  if (!attempts.length) {
    throw new AiError('No Gemini API key configured', {
      code: 'invalid_key',
      status: 401,
    })
  }

  let lastErr: unknown
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]
    try {
      if (i > 0) {
        console.warn(`[gemini] retrying with ${attempt.label}`)
      }
      return await generateOpenAiCompatible(
        { ...args, apiKey: attempt.apiKey, model: attempt.model },
        {
          url: GEMINI_OPENAI_URL,
          providerLabel: 'Gemini',
          maxTokensField: 'max_tokens',
        },
      )
    } catch (err) {
      lastErr = err
      if (i < attempts.length - 1 && shouldRetryGeminiAttempt(err)) continue
      throw err
    }
  }
  throw lastErr
}
