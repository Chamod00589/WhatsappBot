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
  openRouterProviderPreferences,
  shouldSuggestOpenRouterZdrFallback,
} from '@/lib/ai/providers/openrouter-routing'
import { AiError } from '@/lib/ai/types'
import type { MatchableQuickReply } from './match-products'
import type { CustomQuickReply } from './match-custom-qr'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** Max model↔tool rounds so identify → quote can complete in one dispatch. */
const MAX_TOOL_ROUNDS = 4

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
    .slice(0, 40)
    .map(
      (q) =>
        `- ${q.title} | id=${q.id}` +
        (q.catalog_message_id ? ` | catalog=${q.catalog_message_id}` : '') +
        (q.description ? ` | ${q.description.slice(0, 140)}` : ''),
    )
    .join('\n')

  const imageNote = args.inboundImages.length
    ? `Customer attached ${args.inboundImages.length} image(s) this turn — call identify_product when they look like bag photos.`
    : 'No new images this turn.'

  const parts = [
    'You are the Ladies Bags WhatsApp sales agent for ladiesbags.lk.',
    'You are the single decision-maker for this conversation. Read the full recent chat, then call one or more tools to help.',
    'You MAY call multiple tools in the same turn for mixed intents (e.g. find_product + generate_quote + answer_delivery).',
    'Prefer tools over guessing. Never invent catalog prices, delivery times, or return policies — use generate_quote / answer_delivery / answer_policy.',
    'Flow tips:',
    '- Bag photo → identify_product (send_product_card true unless you need facts only).',
    '- Customer names a bag → find_product.',
    '- Asks price / how much / kochchara → generate_quote (after bags are known).',
    '- Sends name+address+phone with bag+color → create_order.',
    '- Missing color/qty/address → ask_missing_information (short Singlish/Tanglish).',
    '- Delivery days/shipping FAQ → answer_delivery (not generate_quote).',
    '- Other FAQ → answer_policy.',
    '- Confirms pending order (ok/hari/yes) → confirm_order.',
    '- Add another bag / change color before OR after order create → update_order (mode=add for new bags; color for recolor). If no order yet, server updates the last quotation and re-sends it; if no quotation yet, sends a new quotation.',
    '- After an order exists, update_order re-sends the order confirm screenshot.',
    '- Wholesale, complaints, angry, or unsafe → handover_to_human.',
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
      ? `FAQ / policy / delivery quick replies (use answer_delivery or answer_policy):\n${faqList}`
      : 'No FAQ quick replies configured.',
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
    config.provider === 'openrouter' ? OPENROUTER_URL : OPENAI_URL
  const tools = buildSalesAgentTools(config)
  const timeoutMs = aiRequestTimeoutMs()
  const execCtx = buildExecContext(args)

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

  const callModel = async (model: string): Promise<Response> => {
    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      tools,
      tool_choice: 'auto',
    }
    if (config.provider === 'openrouter') {
      body.max_tokens = MAX_OUTPUT_TOKENS
      body.provider = openRouterProviderPreferences(model)
    } else {
      body.max_completion_tokens = MAX_OUTPUT_TOKENS
    }

    return fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    args.debug?.step('ai_tools', `Model round ${round + 1}/${MAX_TOOL_ROUNDS}`)

    let res: Response
    let usedModel = config.model
    try {
      res = await callModel(config.model)
      if (
        !res.ok &&
        config.provider === 'openrouter' &&
        shouldSuggestOpenRouterZdrFallback(config.model)
      ) {
        const cloned = res.clone()
        const err = await providerHttpError(config.provider, cloned)
        if (isOpenRouterPrivacyError(err)) {
          args.debug?.step(
            'ai_tools',
            `OpenRouter privacy blocked ${config.model} — retrying ${OPENROUTER_ZDR_FALLBACK_MODEL}`,
          )
          usedModel = OPENROUTER_ZDR_FALLBACK_MODEL
          res = await callModel(OPENROUTER_ZDR_FALLBACK_MODEL)
        } else {
          throw err
        }
      }
    } catch (err) {
      if (err instanceof AiError) throw err
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError(config.provider, res)
    if (usedModel !== config.model) {
      args.debug?.step('ai_tools', `Using fallback model ${usedModel}`)
    }

    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function?: { name?: string; arguments?: string }
          }>
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
    const toolCalls: ToolCallRequest[] = (msg?.tool_calls ?? [])
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

    apiMessages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments ?? {}),
        },
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
