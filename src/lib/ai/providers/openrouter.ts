import type { ProviderResult } from '../types'
import type { ProviderArgs } from './shared'
import { generateOpenAiCompatible } from './openai-compatible'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Call OpenRouter's OpenAI-compatible Chat Completions endpoint with
 * the caller's own key. Optional attribution headers help the app show
 * up on OpenRouter leaderboards when configured.
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

  return generateOpenAiCompatible(args, {
    url: OPENROUTER_URL,
    providerLabel: 'OpenRouter',
    extraHeaders,
    // OpenRouter forwards to many upstreams; `max_tokens` is the
    // widely-compatible field across their catalog.
    maxTokensField: 'max_tokens',
  })
}
