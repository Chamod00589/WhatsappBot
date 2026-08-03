import type { ProviderResult } from '../types'
import type { ProviderArgs } from './shared'
import { generateOpenAiCompatible } from './openai-compatible'
import {
  OPENROUTER_ZDR_FALLBACK_MODEL,
  isOpenRouterPrivacyError,
  isOpenRouterRateLimitError,
  openRouterClientRetryModels,
  openRouterFallbackModels,
  openRouterProviderPreferences,
  shouldSuggestOpenRouterZdrFallback,
} from './openrouter-routing'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Call OpenRouter's OpenAI-compatible Chat Completions endpoint with
 * the caller's own key. Optional attribution headers help the app show
 * up on OpenRouter leaderboards when configured.
 *
 * Resilience:
 * 1. Passes OpenRouter `models` fallbacks so rate-limit / downtime
 *    auto-routes to the next model (Gemini free quota → lite / free LLMs).
 * 2. On privacy/ZDR blocks, retries once with a known ZDR-capable model.
 * 3. On rate-limit after (1), walks the fallback list client-side.
 */
export async function generateOpenRouter(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const referer =
    process.env.OPENROUTER_HTTP_REFERER?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    ''
  const title =
    process.env.OPENROUTER_APP_TITLE?.trim() || 'WhatsApp CRM'

  const extraHeaders: Record<string, string> = {
    'X-OpenRouter-Title': title,
  }
  if (referer) extraHeaders['HTTP-Referer'] = referer

  const call = (model: string, withFallbacks: boolean) => {
    const fallbacks = withFallbacks ? openRouterFallbackModels(model) : []
    return generateOpenAiCompatible(
      { ...args, model },
      {
        url: OPENROUTER_URL,
        providerLabel: 'OpenRouter',
        extraHeaders,
        maxTokensField: 'max_tokens',
        extraBody: {
          provider: openRouterProviderPreferences(model),
          ...(fallbacks.length ? { models: fallbacks } : {}),
        },
      },
    )
  }

  try {
    return await call(args.model, true)
  } catch (err) {
    if (
      isOpenRouterPrivacyError(err) &&
      shouldSuggestOpenRouterZdrFallback(args.model)
    ) {
      console.warn(
        `[openrouter] privacy/ZDR blocked model "${args.model}" — retrying with ${OPENROUTER_ZDR_FALLBACK_MODEL}`,
      )
      try {
        return await call(OPENROUTER_ZDR_FALLBACK_MODEL, true)
      } catch (zdrErr) {
        if (!isOpenRouterRateLimitError(zdrErr)) throw zdrErr
        err = zdrErr
      }
    }

    if (isOpenRouterRateLimitError(err)) {
      const retries = openRouterClientRetryModels(args.model)
      for (const next of retries) {
        console.warn(
          `[openrouter] rate/quota limit on "${args.model}" — retrying with ${next}`,
        )
        try {
          // Don't nest another models[] chain on the retry target —
          // walk the list ourselves so we get clear logs per attempt.
          return await call(next, false)
        } catch (nextErr) {
          if (
            isOpenRouterRateLimitError(nextErr) ||
            isOpenRouterPrivacyError(nextErr)
          ) {
            continue
          }
          throw nextErr
        }
      }
    }

    throw err
  }
}
