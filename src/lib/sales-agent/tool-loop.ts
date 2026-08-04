import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfigWithSales } from './types'
import type { ChatMessage, AiUsage } from '@/lib/ai/types'
import {
  aiRequestTimeoutMs,
  HANDOFF_SENTINEL,
  MAX_OUTPUT_TOKENS,
} from '@/lib/ai/defaults'
import {
  normalizeUsage,
  mergeConsecutive,
  toNetworkError,
  providerHttpError,
} from '@/lib/ai/providers/shared'
import {
  buildSalesAgentTools,
  AGENT_TOOL_NAMES,
  type ToolCallRequest,
} from './tools'
import {
  executeAgentTool,
  type ToolExecContext,
} from './tool-executors'
import { languageHintForPrompt, type ReplyMode } from './language'
import type { SalesAgentRunLogger } from './debug-log'
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
import { AiError } from '@/lib/ai/types'
import type { MatchableQuickReply } from './match-products'
import type { CustomQuickReply } from './match-custom-qr'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Max model↔tool rounds per inbound handle (identify → quote → FAQ, etc.). */
const MAX_TOOL_ROUNDS = 3

export interface ToolLoopArgs {
  db: SupabaseClient
  config: AiConfigWithSales
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string | null
  messages: ChatMessage[]
  /** Extra facts for the system prompt (pending order, images, etc.). */
  systemExtra: string
  useSinglish: boolean
  replyMode?: ReplyMode
  productCatalog: MatchableQuickReply[]
  customCatalog: CustomQuickReply[]
  inboundImages: Array<{
    mediaUrl?: string | null
    metaMediaId?: string | null
    caption?: string | null
  }>
  burstText: string
  debug?: SalesAgentRunLogger
}

export interface ToolLoopResult {
  replied: boolean
  handoff: boolean
  usage: AiUsage | null
  replyText?: string
}

/**
 * LLM-first Sales Agent loop: model decides tools; executors perform side effects.
 * Supports multiple tool rounds so identify → find/quote/order can chain.
 */
export async function runSalesAgentToolLoop(
  args: ToolLoopArgs,
): Promise<ToolLoopResult> {
  const { config } = args
  if (!config.aiText) {
    return { replied: false, handoff: false, usage: null }
  }

  const systemPrompt = buildAgentSystemPrompt(args)
  if (config.provider === 'anthropic') {
    return runJsonActionLoop(args, systemPrompt)
  }
  return runOpenAiToolLoop(args, systemPrompt)
}

function buildAgentSystemPrompt(args: ToolLoopArgs): string {
  const { config, productCatalog, customCatalog, useSinglish } = args
  const replyMode: ReplyMode =
    args.replyMode ?? (useSinglish ? 'singlish' : 'tanglish')

  const productList = productCatalog
    .slice(0, 60)
    .map(
      (q) =>
        `- ${q.title} | id=${q.id}` +
        (q.product_id ? ` | product=${q.product_id}` : '') +
        (q.catalog_message_id ? ` | catalog=${q.catalog_message_id}` : ''),
    )
    .join('\n')

  const faqList = customCatalog
    .slice(0, 80)
    .map((q) => {
      const desc = (q.description || '').trim() || '(no description)'
      return (
        `- ${q.title}\n` +
        `  id=${q.id}` +
        (q.catalog_message_id ? ` | catalog=${q.catalog_message_id}` : '') +
        `\n  description: ${desc.slice(0, 400)}`
      )
    })
    .join('\n')

  const imageNote = args.inboundImages.length
    ? `Customer attached ${args.inboundImages.length} image(s) this turn — call identify_product when they look like bag photos.`
    : 'No new images this turn.'

  const parts = [
    'You are the Ladies Bags WhatsApp sales agent for ladiesbags.lk.',
    'You are the single decision-maker for this conversation. Read the full recent chat, then call one or more tools to help.',
    'You MAY call multiple tools in the same turn for mixed intents (e.g. find_product + generate_quote + answer_delivery).',
    'You have up to 3 tool rounds this turn. If a tool returns need=quick_reply_id or "not found", pick a better id from the FAQ list and retry — or call handover_to_human.',
    'Prefer tools over guessing. Never invent catalog prices, delivery times, or return policies.',
    'FAQ / delivery / policy answers:',
    '- Read every FAQ description below carefully (Singlish/English).',
    '- Choose the single most suitable quick reply for the customer question.',
    '- Call answer_delivery or answer_policy with that quick_reply_id (or catalog_message_id). Do NOT rely on fuzzy text matching — you must pass the id.',
    '- If NONE of the FAQ descriptions fit the question, call handover_to_human (do not invent an answer).',
    'Flow tips:',
    '- Bag photo → identify_product (send_product_card true). Server sends matching product QR card(s), then AUTOMATICALLY sends a price quotation for those bags — you do NOT need to call generate_quote after a successful identify that already set quotation_sent=true.',
    '- Identify catalog may include several angles of the same color (Pink / Pink__2) and product-only multi-color shots (_1). If identified[].colorKnown is false or color is empty / color_unknown is set, ask which color with ask_missing_information — never invent black/white/pink.',
    '- Caption text about THIS photo ("me bag 2k", "meka white") applies qty/color to that bag. Other named bags in the same burst ("Mini red 1i") are also saved — use saved_items from the tool result for order colors (do not invent black/white).',
    '- If the customer swipe-replies to a product QR image and says "me color eken" / price — Session state lists the replied bag+color. ALWAYS use that color for generate_quote / create_order (ignore older identify colors).',
    '- Customer names a bag → find_product (pass color + quantity when known). After find_product, call generate_quote if they want price / cart total.',
    '- Asks price / how much / kochchara (and identify did not just auto-quote) → generate_quote using saved_items / correct colors from identify (never guess a different color than identify returned).',
    '- After the FIRST quotation in a chat, the server auto-sends Address Quick Reply (order address format) ONCE. Do NOT call answer_policy for Address on every new bag/quote.',
    '- Later product asks in the SAME chat → product QR + quotation only (Address QR already sent). Quotation images have NO address caption.',
    '- Customer asks address format / how to order / order details format again → answer_policy with Address Quick Reply id (re-send is OK).',
    '- Sends name+address+phone with bag+color → create_order using the same saved colors/qty.',
    '- Missing color/qty/address → ask_missing_information (short Singlish/Tanglish).',
    '- Delivery fee/time/shipping ("deliver gasthuwa", "dawasak") → answer_delivery with the delivery FAQ id.',
    '- Other FAQ → answer_policy with the matching FAQ id.',
    '- Confirms pending order (ok/hari/yes) → confirm_order.',
    '- Add another bag / change color before OR after order create → update_order (mode=add for new bags; color for recolor). If no order yet, server updates the last quotation and re-sends it; if no quotation yet, sends a new quotation.',
    '- "dekakuth" / "ekakuth" / "thawa" = ADD onto the last quotation. Pass only the NEW lines. If they already have White x1 and ask for 2 Black of the same bag, items=[{name, color:Black, quantity:2}] mode=add — do NOT replace White with Black.',
    '- "me color" after a product QR (all colors shown) is ambiguous — ask which color unless Session state / swipe-reply names one. Never invent Black.',
    '- After an order exists, update_order re-sends the order confirm screenshot.',
    '- Wholesale, complaints, angry, unknown, or no matching FAQ → handover_to_human.',
    languageHintForPrompt(replyMode),
    'Keep ask_missing_information messages short (1–2 sentences). Do not dump long policy text as free messages.',
    `If you cannot help safely, call handover_to_human or reply with exactly ${HANDOFF_SENTINEL}.`,
    imageNote,
    config.systemPrompt?.trim()
      ? `Business context:\n${config.systemPrompt.trim()}`
      : '',
    args.systemExtra?.trim() ? `Session state:\n${args.systemExtra.trim()}` : '',
    productList
      ? `Catalog product cards (use find_product / generate_quote):\n${productList}`
      : 'No product cards configured.',
    faqList
      ? `FAQ / policy / delivery quick replies (YOU pick the best id by description):\n${faqList}`
      : 'No FAQ quick replies configured — for FAQ/delivery questions call handover_to_human.',
  ]
  return parts.filter(Boolean).join('\n\n')
}

function buildExecContext(args: ToolLoopArgs): ToolExecContext {
  const replyMode: ReplyMode =
    args.replyMode ?? (args.useSinglish ? 'singlish' : 'tanglish')
  return {
    db: args.db,
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    configOwnerUserId: args.configOwnerUserId,
    contactPhone: args.contactPhone,
    useSinglish: args.useSinglish,
    replyMode,
    quotationEnabled: Boolean(args.config.quotation),
    quoteSentThisTurn: false,
    inboundImages: args.inboundImages,
    burstText: args.burstText,
    productCatalog: args.productCatalog,
    customCatalog: args.customCatalog,
  }
}

async function runOpenAiToolLoop(
  args: ToolLoopArgs,
  systemPrompt: string,
): Promise<ToolLoopResult> {
  const { config } = args
  const url =
    config.provider === 'openrouter'
      ? OPENROUTER_URL
      : config.provider === 'gemini'
        ? GEMINI_OPENAI_URL
        : OPENAI_URL
  const tools = buildSalesAgentTools(config)
  const timeoutMs = aiRequestTimeoutMs()
  const execCtx = buildExecContext(args)

  type GeminiExtraContent = {
    google?: { thought_signature?: string }
  }

  type RawToolCall = {
    id: string
    type?: string
    function?: { name?: string; arguments?: string }
    /** Gemini 3 OpenAI-compat: must be echoed on the next request. */
    extra_content?: GeminiExtraContent
  }

  type ApiMessage =
    | { role: 'system'; content: string }
    | { role: 'user' | 'assistant'; content: string }
    | {
        role: 'assistant'
        content: string | null
        tool_calls: Array<{
          id: string
          type: 'function'
          function: { name: string; arguments: string }
          extra_content?: GeminiExtraContent
        }>
      }
    | { role: 'tool'; tool_call_id: string; content: string }

  const apiMessages: ApiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(args.messages).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ]

  let replied = false
  let handoff = false
  let lastText = ''
  let usageAcc: AiUsage | null = null
  const toolLog: Array<{ name: string; arguments: unknown; result?: string }> =
    []

  const callModel = async (
    model: string,
    withFallbacks: boolean,
    apiKeyOverride?: string,
  ): Promise<Response> => {
    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      tools,
      tool_choice: 'auto',
    }
    if (config.provider === 'openrouter') {
      body.max_tokens = MAX_OUTPUT_TOKENS
      body.provider = openRouterProviderPreferences(model)
      if (withFallbacks) {
        const fallbacks = openRouterFallbackModels(model)
        if (fallbacks.length) body.models = fallbacks
      }
    } else if (config.provider === 'gemini') {
      body.max_tokens = MAX_OUTPUT_TOKENS
      // Gemini 3.x Flash-Lite defaults to thinking; keep it minimal for
      // fast tool loops (signatures are still required and preserved).
      body.extra_body = {
        google: {
          thinking_config: { thinking_level: 'minimal' },
        },
      }
    } else {
      body.max_completion_tokens = MAX_OUTPUT_TOKENS
    }

    return fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyOverride || config.apiKey}`,
        'Content-Type': 'application/json',
        ...(config.provider === 'openrouter'
          ? {
              'HTTP-Referer': 'https://ladiesbags.lk',
              'X-Title': 'LadiesBags Sales Agent',
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /** Gemini: try key×model cascade to spread free-tier quota. */
  const callGeminiWithFallback = async (): Promise<{
    res: Response
    usedModel: string
    apiKey: string
    label: string
  }> => {
    const attempts = buildGeminiAttempts({
      apiKey: config.apiKey,
      apiKey2: config.apiKey2,
      preferredModel: config.model,
    })
    if (!attempts.length) {
      throw new AiError('No Gemini API key configured', {
        code: 'invalid_key',
        status: 401,
      })
    }

    let lastErr: AiError | null = null
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]
      if (i > 0) {
        args.debug?.step(
          'ai_tools',
          `Gemini fallback → ${attempt.label}`,
        )
      }
      const res = await callModel(attempt.model, false, attempt.apiKey)
      if (res.ok) {
        return {
          res,
          usedModel: attempt.model,
          apiKey: attempt.apiKey,
          label: attempt.label,
        }
      }
      const err = await providerHttpError('Gemini', res.clone())
      lastErr = err
      if (i < attempts.length - 1 && shouldRetryGeminiAttempt(err)) {
        args.debug?.step(
          'ai_tools',
          `${attempt.label} failed (${err.message.slice(0, 120)}) — trying next`,
        )
        continue
      }
      throw err
    }
    throw lastErr || new AiError('Gemini unavailable', { code: 'provider_error' })
  }

  /** Sticky key for Gemini follow-up rounds (thought_signature continuity). */
  let stickyGeminiKey: string | undefined
  let stickyGeminiModel: string | undefined

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    args.debug?.step('ai_tools', `Model round ${round + 1}/${MAX_TOOL_ROUNDS}`)

    let res: Response
    let usedModel = stickyGeminiModel || config.model
    try {
      if (config.provider === 'gemini') {
        // First Gemini round: walk the key×model cascade. Later rounds reuse
        // the same key+model so thought_signature stays valid.
        if (!stickyGeminiKey || !stickyGeminiModel) {
          const picked = await callGeminiWithFallback()
          res = picked.res
          usedModel = picked.usedModel
          stickyGeminiKey = picked.apiKey
          stickyGeminiModel = picked.usedModel
          args.debug?.step('ai_tools', `Gemini using ${picked.label}`)
        } else {
          res = await callModel(stickyGeminiModel, false, stickyGeminiKey)
        }
      } else {
        res = await callModel(config.model, true)
        if (!res.ok && config.provider === 'openrouter') {
          const cloned = res.clone()
          const err = await providerHttpError(config.provider, cloned)

          if (
            isOpenRouterPrivacyError(err) &&
            shouldSuggestOpenRouterZdrFallback(config.model)
          ) {
            args.debug?.step(
              'ai_tools',
              `OpenRouter privacy blocked ${config.model} — retrying ${OPENROUTER_ZDR_FALLBACK_MODEL}`,
            )
            usedModel = OPENROUTER_ZDR_FALLBACK_MODEL
            res = await callModel(OPENROUTER_ZDR_FALLBACK_MODEL, true)
          } else if (isOpenRouterRateLimitError(err)) {
            const retries = openRouterClientRetryModels(config.model)
            let recovered = false
            for (const next of retries) {
              args.debug?.step(
                'ai_tools',
                `OpenRouter rate/quota on ${usedModel} — retrying ${next}`,
              )
              usedModel = next
              res = await callModel(next, false)
              if (res.ok) {
                recovered = true
                break
              }
              const nextErr = await providerHttpError(
                config.provider,
                res.clone(),
              )
              if (
                !isOpenRouterRateLimitError(nextErr) &&
                !isOpenRouterPrivacyError(nextErr)
              ) {
                throw nextErr
              }
            }
            if (!recovered && !res.ok) throw err
          } else {
            throw err
          }
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err
      throw toNetworkError(err)
    }
    if (!res.ok) {
      // Product/FAQ already sent on an earlier round — don't fail the whole
      // turn (and tag Human) because Gemini rejected the follow-up request
      // (common before thought_signature echo was preserved).
      if (replied) {
        const err = await providerHttpError(
          config.provider === 'gemini' ? 'Gemini' : config.provider,
          res,
        )
        args.debug?.step(
          'policy',
          `Follow-up model round failed after a successful tool reply — stopping cleanly: ${err.message}`,
        )
        break
      }
      throw await providerHttpError(
        config.provider === 'gemini' ? 'Gemini' : config.provider,
        res,
      )
    }
    if (usedModel !== config.model) {
      args.debug?.step('ai_tools', `Using fallback model ${usedModel}`)
    }

    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null
          tool_calls?: RawToolCall[]
        }
        finish_reason?: string
      }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
    }

    const roundUsage = normalizeUsage({
      prompt: data.usage?.prompt_tokens,
      completion: data.usage?.completion_tokens,
      total: data.usage?.total_tokens,
    })
    usageAcc = mergeUsage(usageAcc, roundUsage)

    const msg = data.choices?.[0]?.message
    const rawToolCalls = msg?.tool_calls ?? []
    const toolCalls: ToolCallRequest[] = rawToolCalls
      .map((tc) => {
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(tc.function?.arguments || '{}') as Record<
            string,
            unknown
          >
        } catch {
          parsed = {}
        }
        return {
          id: tc.id,
          name: tc.function?.name || '',
          arguments: parsed,
        }
      })
      .filter((t) => t.name)

    const text = (msg?.content || '').trim()
    if (text) lastText = text

    if (text.includes(HANDOFF_SENTINEL)) {
      handoff = true
      break
    }

    if (!toolCalls.length) {
      // No tools: only escalate if we also didn't already help this turn
      if (!replied) {
        handoff = true
        args.debug?.step(
          'policy',
          'No tool calls and nothing sent — escalate Human',
        )
      } else {
        args.debug?.step(
          'policy',
          'Model finished with follow-up text after tools — ignored',
        )
      }
      break
    }

    // Echo tool_calls exactly as Gemini returned them — including
    // `extra_content.google.thought_signature`. Reconstructing drops the
    // signature and Gemini 3 returns HTTP 400 on the next round.
    apiMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: rawToolCalls
        .filter((tc) => tc.id && tc.function?.name)
        .map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function!.name!,
            arguments: tc.function?.arguments || '{}',
          },
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
        })),
    })

    for (const call of toolCalls) {
      args.debug?.step('tool', `Calling ${call.name}`, call.arguments)
      const result = await executeAgentTool(execCtx, call)
      toolLog.push({
        name: call.name,
        arguments: call.arguments,
        result: result.note,
      })
      args.debug?.step(
        'tool',
        `${call.name} → ${result.note || (result.replied ? 'ok' : 'no-op')}`,
      )
      if (result.replied) replied = true
      if (result.handoff) handoff = true

      apiMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({
          ok: result.replied || !result.handoff,
          note: result.note,
          ...(result.resultPayload && typeof result.resultPayload === 'object'
            ? (result.resultPayload as object)
            : { data: result.resultPayload }),
        }),
      })
    }

    if (handoff) break
    // Continue another round so the model can act on tool results
  }

  if (toolLog.length) args.debug?.set({ tools: toolLog })

  if (!replied && !handoff) {
    handoff = true
    args.debug?.step(
      'policy',
      'Tools produced no customer reply — escalate Human',
    )
  }

  return {
    replied,
    handoff,
    usage: usageAcc,
    replyText: lastText || undefined,
  }
}

async function runJsonActionLoop(
  args: ToolLoopArgs,
  systemPrompt: string,
): Promise<ToolLoopResult> {
  const { generateAnthropic } = await import('@/lib/ai/providers/anthropic')
  const execCtx = buildExecContext(args)
  const prompt =
    systemPrompt +
    `\n\nRespond with ONLY JSON: {"actions":[{"name":"tool_name","arguments":{...}}],"handoff":false}. ` +
    `Call every tool needed for this customer message (multiple actions allowed). ` +
    `Do not put customer answers in free text — use ask_missing_information for clarifying questions. ` +
    `Allowed action names: ${AGENT_TOOL_NAMES.join(', ')}.`

  const result = await generateAnthropic({
    apiKey: args.config.apiKey,
    model: args.config.model,
    systemPrompt: prompt,
    messages: args.messages,
    timeoutMs: aiRequestTimeoutMs(),
  })

  let replied = false
  let handoff = false
  let replyText: string | undefined
  const toolLog: Array<{ name: string; arguments: unknown; result?: string }> =
    []

  try {
    const jsonText = extractJson(result.text)
    const parsed = JSON.parse(jsonText) as {
      reply?: string
      handoff?: boolean
      actions?: Array<{ name: string; arguments?: Record<string, unknown> }>
    }
    if (parsed.handoff) handoff = true
    for (const a of parsed.actions ?? []) {
      args.debug?.step('tool', `Calling ${a.name}`, a.arguments)
      const r = await executeAgentTool(execCtx, {
        id: a.name,
        name: a.name,
        arguments: a.arguments ?? {},
      })
      toolLog.push({
        name: a.name,
        arguments: a.arguments ?? {},
        result: r.note,
      })
      if (r.replied) replied = true
      if (r.handoff) handoff = true
    }
    if (toolLog.length) args.debug?.set({ tools: toolLog })
    const reply = (parsed.reply || '').trim()
    replyText = reply
    if (reply.includes(HANDOFF_SENTINEL)) handoff = true
    if (!replied && !handoff) {
      handoff = true
      args.debug?.step(
        'policy',
        'No tool reply — escalate Human',
      )
    }
  } catch (err) {
    const text = result.text.replace(HANDOFF_SENTINEL, '').trim()
    replyText = text
    handoff = true
    if (!result.text.includes(HANDOFF_SENTINEL)) {
      console.warn('[sales-agent] anthropic JSON parse failed — escalate:', err)
    }
  }

  return { replied, handoff, usage: result.usage, replyText }
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) return fenced[1].trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return raw.trim()
}

function mergeUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
  }
}
