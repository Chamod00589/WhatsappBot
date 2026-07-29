import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

interface OpenAiCompatibleResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export interface OpenAiCompatibleOpts {
  /** Full chat-completions URL. */
  url: string
  /** Label used in error messages (e.g. "OpenAI", "OpenRouter"). */
  providerLabel: string
  /** Extra request headers (attribution, etc.). */
  extraHeaders?: Record<string, string>
  /**
   * Which max-tokens field the upstream expects. OpenAI's newer API
   * uses `max_completion_tokens`; OpenRouter and most OpenAI-compat
   * gateways still accept `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Extra top-level JSON fields merged into the request body. */
  extraBody?: Record<string, unknown>
}

/**
 * Shared Chat Completions caller for OpenAI-compatible endpoints
 * (OpenAI itself, OpenRouter, …).
 */
export async function generateOpenAiCompatible(
  args: ProviderArgs,
  opts: OpenAiCompatibleOpts,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const {
    url,
    providerLabel,
    extraHeaders,
    maxTokensField = 'max_completion_tokens',
    extraBody,
  } = opts

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...mergeConsecutive(messages),
    ],
    ...extraBody,
  }
  body[maxTokensField] = MAX_OUTPUT_TOKENS

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError(providerLabel, res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiCompatibleResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError(`${providerLabel} returned an empty response.`, {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
