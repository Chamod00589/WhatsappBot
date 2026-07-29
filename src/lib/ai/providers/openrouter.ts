import type { ProviderResult } from '../types'
import type { ProviderArgs } from './shared'
import { generateOpenAiCompatible } from './openai-compatible'
import {
  OPENROUTER_ZDR_FALLBACK_MODEL,
  isOpenRouterPrivacyError,
  openRouterProviderPreferences,
  shouldSuggestOpenRouterZdrFallback,
} from './openrouter-routing'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Call OpenRouter's OpenAI-compatible Chat Completions endpoint with
 * the caller's own key. Optional attribution headers help the app show
 * up on OpenRouter leaderboards when configured.
 *
 * When the account has ZDR/privacy restrictions that block the configured
 * model (common with openai/gpt-4o-mini), we retry once with a known
 * ZDR-capable model so Sales Agent keeps working.
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

  const call = (model: string) =>
    generateOpenAiCompatible(
      { ...args, model },
      {
        url: OPENROUTER_URL,
        providerLabel: 'OpenRouter',
        extraHeaders,
        maxTokensField: 'max_tokens',
        extraBody: {
          provider: openRouterProviderPreferences(model),
        },
      },
    )

  try {
    return await call(args.model)
  } catch (err) {
    if (
      isOpenRouterPrivacyError(err) &&
      shouldSuggestOpenRouterZdrFallback(args.model)
    ) {
      console.warn(
        `[openrouter] privacy/ZDR blocked model "${args.model}" — retrying with ${OPENROUTER_ZDR_FALLBACK_MODEL}`,
      )
      return await call(OPENROUTER_ZDR_FALLBACK_MODEL)
    }
    throw err
  }
}
