import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfigWithSales } from './types'
import type { ChatMessage, AiUsage } from '@/lib/ai/types'
import { aiRequestTimeoutMs, HANDOFF_SENTINEL, MAX_OUTPUT_TOKENS } from '@/lib/ai/defaults'
import { normalizeUsage, mergeConsecutive, toNetworkError, providerHttpError } from '@/lib/ai/providers/shared'
import { buildSalesAgentTools, type ToolCallRequest } from './tools'
import {
  actionCreateOrder,
  actionEditOrder,
  actionMarkHuman,
  actionSendQuotation,
  actionSendTracking,
} from './actions/orders'
import { sendQuickReplyByCatalogId, sendLocalTextQuickReply } from './send-quick-reply'
import { engineSendText } from '@/lib/flows/meta-send'
import type { OrderLineItem } from '@/lib/orders/constants'
import { languageHintForPrompt } from './language'
import type { SalesAgentRunLogger } from './debug-log'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface ToolLoopArgs {
  db: SupabaseClient
  config: AiConfigWithSales
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string | null
  messages: ChatMessage[]
  systemExtra: string
  useSinglish: boolean
  availableQuickReplies: Array<{
    id: string
    title: string
    description: string | null
    catalog_message_id: string | null
  }>
  /** Optional troubleshoot logger from dispatch. */
  debug?: SalesAgentRunLogger
}

export interface ToolLoopResult {
  replied: boolean
  handoff: boolean
  usage: AiUsage | null
  replyText?: string
}

/**
 * One-shot tool-calling round (OpenAI-compatible). Anthropic falls back
 * to JSON action instructions in the system prompt.
 */
export async function runSalesAgentToolLoop(
  args: ToolLoopArgs,
): Promise<ToolLoopResult> {
  const { config } = args
  if (!config.aiText) {
    return { replied: false, handoff: false, usage: null, replyText: undefined }
  }

  const systemPrompt = buildAgentSystemPrompt(args)
  if (config.provider === 'anthropic') {
    return runJsonActionLoop(args, systemPrompt)
  }
  return runOpenAiToolLoop(args, systemPrompt)
}

function buildAgentSystemPrompt(args: ToolLoopArgs): string {
  const { config, availableQuickReplies, useSinglish } = args
  const qrList = availableQuickReplies
    .slice(0, 80)
    .map(
      (q) =>
        `- ${q.title} | id=${q.id}` +
        (q.catalog_message_id ? ` | catalog=${q.catalog_message_id}` : '') +
        (q.description ? ` | ${q.description.slice(0, 120)}` : ''),
    )
    .join('\n')

  const parts = [
    'You are the Ladies Bags WhatsApp sales agent for ladiesbags.lk.',
    'Prefer sending existing quick replies over inventing product prices or details.',
    languageHintForPrompt(useSinglish),
    'Keep replies short. Do not repeat an answer the customer already received.',
    `If you cannot help safely (wholesale, unknown policy, angry customer), call mark_human or reply with exactly ${HANDOFF_SENTINEL}.`,
    'You may call tools to send quick replies, create orders, send quotations/tracking, edit orders, or escalate.',
    config.systemPrompt?.trim()
      ? `Business context:\n${config.systemPrompt.trim()}`
      : '',
    qrList
      ? `Available quick replies (use send_quick_reply):\n${qrList}`
      : '',
  ]
  return parts.filter(Boolean).join('\n\n')
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

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...mergeConsecutive(args.messages),
    ],
    tools,
    tool_choice: 'auto',
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(config.provider === 'openrouter'
          ? { 'HTTP-Referer': 'https://ladiesbags.lk', 'X-Title': 'LadiesBags Sales Agent' }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError(config.provider, res)

  const data = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null
        tool_calls?: Array<{
          id: string
          function?: { name?: string; arguments?: string }
        }>
      }
    }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }

  const usage = normalizeUsage({
    prompt: data.usage?.prompt_tokens,
    completion: data.usage?.completion_tokens,
    total: data.usage?.total_tokens,
  })

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

  let replied = false
  let handoff = false
  const toolLog: Array<{ name: string; arguments: unknown; result?: string }> =
    []

  for (const call of toolCalls) {
    args.debug?.step('tool', `Calling ${call.name}`, call.arguments)
    const result = await executeToolCall(args, call)
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
  }
  if (toolLog.length) args.debug?.set({ tools: toolLog })

  const text = (msg?.content || '').trim()
  if (text.includes(HANDOFF_SENTINEL)) {
    handoff = true
  } else if (text && !toolCalls.length) {
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text,
      aiGenerated: true,
    })
    replied = true
  } else if (text && toolCalls.length) {
    // Optional follow-up text after tools
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text,
      aiGenerated: true,
    })
    replied = true
  }

  return { replied, handoff, usage, replyText: text || undefined }
}

async function runJsonActionLoop(
  args: ToolLoopArgs,
  systemPrompt: string,
): Promise<ToolLoopResult> {
  // Anthropic: ask for a single JSON object, no native tools required.
  const { generateAnthropic } = await import('@/lib/ai/providers/anthropic')
  const prompt =
    systemPrompt +
    `\n\nRespond with ONLY JSON: {"reply":"optional customer text or empty","actions":[{"name":"tool_name","arguments":{...}}],"handoff":false}. ` +
    `Allowed action names: send_quick_reply, create_order, send_quotation, send_tracking, edit_order, mark_human.`

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
      const r = await executeToolCall(args, {
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
    if (reply && !reply.includes(HANDOFF_SENTINEL)) {
      await engineSendText({
        accountId: args.accountId,
        userId: args.configOwnerUserId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text: reply,
        aiGenerated: true,
      })
      replied = true
    }
    if (reply.includes(HANDOFF_SENTINEL)) handoff = true
  } catch (err) {
    // Fallback: treat as plain text
    const text = result.text.replace(HANDOFF_SENTINEL, '').trim()
    replyText = text
    if (result.text.includes(HANDOFF_SENTINEL)) handoff = true
    else if (text) {
      await engineSendText({
        accountId: args.accountId,
        userId: args.configOwnerUserId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text,
        aiGenerated: true,
      })
      replied = true
    } else {
      console.warn('[sales-agent] anthropic JSON parse failed:', err)
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

async function executeToolCall(
  args: ToolLoopArgs,
  call: ToolCallRequest,
): Promise<{ replied: boolean; handoff: boolean; note: string }> {
  const { db, accountId, conversationId, contactId, configOwnerUserId } = args
  const a = call.arguments

  switch (call.name) {
    case 'send_quick_reply': {
      const catalogId =
        typeof a.catalog_message_id === 'string' ? a.catalog_message_id : ''
      const qrId = typeof a.quick_reply_id === 'string' ? a.quick_reply_id : ''
      if (catalogId) {
        await sendQuickReplyByCatalogId({
          db,
          accountId,
          conversationId,
          catalogMessageId: catalogId,
          contextSummary:
            typeof a.reason === 'string'
              ? `Sent quick reply: ${a.reason}`
              : `Sent catalog quick reply ${catalogId}`,
        })
        return { replied: true, handoff: false, note: `sent catalog ${catalogId}` }
      }
      if (qrId) {
        const { data: qr } = await db
          .from('quick_replies')
          .select('*')
          .eq('id', qrId)
          .eq('account_id', accountId)
          .maybeSingle()
        if (qr?.catalog_message_id) {
          await sendQuickReplyByCatalogId({
            db,
            accountId,
            conversationId,
            catalogMessageId: qr.catalog_message_id,
            contextSummary: qr.description || qr.title,
          })
          return {
            replied: true,
            handoff: false,
            note: `sent QR ${qr.title}`,
          }
        }
        if (qr?.kind === 'text' && qr.content_text) {
          await sendLocalTextQuickReply({
            db,
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: qr.content_text,
            contextSummary: qr.description || qr.title,
          })
          return {
            replied: true,
            handoff: false,
            note: `sent text QR ${qr.title}`,
          }
        }
      }
      return { replied: false, handoff: false, note: 'quick reply not found' }
    }
    case 'create_order': {
      const addressText =
        typeof a.address_text === 'string' ? a.address_text : ''
      const items = normalizeItems(a.items)
      const r = await actionCreateOrder({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        addressText,
        items,
        contactPhone: args.contactPhone,
        useSinglish: args.useSinglish,
      })
      return { replied: r.ok, handoff: false, note: r.message }
    }
    case 'send_quotation': {
      const items = normalizeItems(a.items)
      const r = await actionSendQuotation({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        items,
        useSinglish: args.useSinglish,
      })
      return { replied: r.ok, handoff: false, note: r.message }
    }
    case 'send_tracking': {
      if (!args.contactPhone) {
        return { replied: false, handoff: false, note: 'no contact phone' }
      }
      const r = await actionSendTracking({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        contactPhone: args.contactPhone,
      })
      return { replied: r.ok, handoff: false, note: r.message }
    }
    case 'edit_order': {
      const orderId = typeof a.order_id === 'string' ? a.order_id : ''
      const patch =
        a.patch && typeof a.patch === 'object'
          ? (a.patch as Record<string, unknown>)
          : {}
      if (!orderId) {
        return { replied: false, handoff: false, note: 'missing order_id' }
      }
      const r = await actionEditOrder({ orderId, patch })
      return { replied: false, handoff: false, note: r.message }
    }
    case 'mark_human': {
      await actionMarkHuman({
        db,
        accountId,
        conversationId,
        contactId,
        reason: typeof a.reason === 'string' ? a.reason : undefined,
      })
      return { replied: false, handoff: true, note: 'marked Human' }
    }
    default:
      console.warn('[sales-agent] unknown tool', call.name)
      return { replied: false, handoff: false, note: `unknown tool ${call.name}` }
  }
}

function normalizeItems(raw: unknown): OrderLineItem[] {
  if (!Array.isArray(raw)) return []
  const out: OrderLineItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : ''
    if (!name) continue
    const qty = Math.max(
      1,
      Number(o.qty ?? o.quantity) || 1,
    )
    out.push({
      productId: typeof o.productId === 'string' ? o.productId : undefined,
      name,
      color: typeof o.color === 'string' ? o.color : '',
      qty,
      price: Number(o.price) || 0,
    })
  }
  return out
}
