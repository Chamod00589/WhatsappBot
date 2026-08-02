import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { logAiUsage } from '@/lib/ai/usage'
import { buildHandoffSummary } from '@/lib/ai/handoff'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import type { AiConfigWithSales, SalesAgentDispatchArgs } from './types'
import {
  parseSalesCapabilities,
  evaluateSalesAgentGates,
  inboundHasTestMarker,
  resetSalesAgentSession,
  stripTestMarker,
} from './gates'
import { buildSalesAgentContext } from './context'
import { detectReplyMode } from './language'
import { parseIdentifyPending } from './identify'
import { parseOrderPending } from './order-intent'
import { actionMarkHuman } from './actions/orders'
import { runSalesAgentToolLoop } from './tool-loop'
import { loadAgentCatalogs } from './tool-executors'
import { SalesAgentRunLogger } from './debug-log'
import { rememberAnsweredQuestion } from './dedupe'

/**
 * Sales Agent entry — LLM-first architecture.
 *
 * Guardrails only before the model: AI off, Human tag, assigned agent,
 * pause, reply cap, rate limit, conflicting automations.
 * Prefer {@link enqueueSalesAgentDispatch} from the webhook so rapid
 * customer messages coalesce into one analysis/reply.
 */
export async function dispatchSalesAgent(
  args: SalesAgentDispatchArgs,
): Promise<void> {
  return dispatchSalesAgentNow(args)
}

/**
 * Immediate (no debounce) Sales Agent run. Used by the debounce flusher
 * and tests that need a single-message dispatch.
 */
export async function dispatchSalesAgentNow(
  args: SalesAgentDispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundText: rawInbound,
    contentType,
    mediaUrl,
    metaMediaId,
    inboundImages: inboundImagesArg,
    isFirstInboundMessage,
  } = args

  const inboundImages =
    inboundImagesArg?.length
      ? inboundImagesArg
      : mediaUrl || metaMediaId
        ? [{ mediaUrl, metaMediaId }]
        : []

  const db = supabaseAdmin()
  const log = new SalesAgentRunLogger(db, {
    accountId,
    conversationId,
    contactId,
    inboundText: rawInbound || '',
    contentType,
  })
  await log.start()
  log.step('inbound', `Received ${contentType}`, {
    text: (rawInbound || '').slice(0, 500),
    hasMedia: Boolean(mediaUrl || metaMediaId),
    metaMediaId: metaMediaId || null,
    burstLines: (rawInbound || '').split('\n').filter((l) => l.trim()).length,
    firstInbound: Boolean(isFirstInboundMessage),
  })

  try {
    const baseConfig = await loadAiConfig(db, accountId)
    if (!baseConfig || !baseConfig.autoReplyEnabled) {
      await log.skip('ai_off', 'AI inactive or auto-reply disabled')
      return
    }

    const { data: rawRow } = await db
      .from('ai_configs')
      .select(
        'sales_agent_enabled, sa_product_match, sa_identify, sa_custom_qr_match, sa_ai_text, sa_create_order, sa_quotation, sa_tracking, sa_edit_order',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    const caps = parseSalesCapabilities(
      (rawRow ?? {}) as Record<string, unknown>,
    )
    const config: AiConfigWithSales = { ...baseConfig, ...caps }
    log.set({
      capabilities: {
        salesAgentEnabled: config.salesAgentEnabled,
        productMatch: config.productMatch,
        identify: config.identify,
        customQrMatch: config.customQrMatch,
        aiText: config.aiText,
        createOrder: config.createOrder,
        quotation: config.quotation,
        tracking: config.tracking,
        editOrder: config.editOrder,
      },
    })

    if (!config.salesAgentEnabled) {
      log.step('gate', 'Sales Agent off — falling back to legacy text AI')
      if (contentType === 'text' && rawInbound.trim()) {
        await dispatchInboundToAiReply({
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
        })
        log.step('legacy_ai', 'Dispatched legacy auto-reply')
        await log.complete()
      } else {
        await log.skip('sales_agent_off', 'Sales Agent disabled')
      }
      return
    }

    const gate = await evaluateSalesAgentGates(db, {
      accountId,
      conversationId,
      contactId,
      config,
    })
    if (!gate.ok) {
      await log.skip(gate.reason, `Gate blocked: ${gate.reason}`)
      return
    }
    log.step('gate', 'Passed eligibility gates', {
      ai_reply_count: gate.conversation.ai_reply_count,
      has_identify_pending: Boolean(gate.conversation.sa_identify_pending),
      has_order_pending: Boolean(gate.conversation.sa_order_pending),
    })

    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) {
      await log.skip(
        'automation_active',
        'Active new_message/keyword automations — Sales Agent stands down',
      )
      return
    }

    if (gate.conversation.ai_reply_count >= config.autoReplyMaxPerConversation) {
      await log.skip(
        'reply_cap',
        `Reply cap reached (${gate.conversation.ai_reply_count}/${config.autoReplyMaxPerConversation})`,
      )
      return
    }

    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      await log.skip('rate_limit', 'Account AI rate limit hit')
      return
    }

    const inboundText = stripTestMarker(rawInbound || '')

    if (inboundHasTestMarker(rawInbound || '')) {
      await resetSalesAgentSession(db, conversationId)
      gate.conversation.sa_order_pending = null
      gate.conversation.sa_identify_pending = null
      gate.conversation.sa_last_question_fp = null
      gate.conversation.ai_reply_count = 0
      log.step(
        'reset',
        '*** marker — cleared bag memory / pending / reply cap; treating as new chat',
      )
      if (!inboundText && inboundImages.length === 0) {
        await log.complete()
        return
      }
    }

    // LLM-first requires the model; without aiText there is no decision layer.
    if (!config.aiText) {
      if (inboundText.trim() || inboundImages.length > 0) {
        await actionMarkHuman({
          db,
          accountId,
          conversationId,
          contactId,
          reason: 'Sales Agent AI decision layer off (sa_ai_text)',
        })
        log.step(
          'handoff',
          'AI decision layer off — tagged Human for manual reply',
        )
      } else {
        log.step('ai_tools', 'AI decision layer off — stop')
      }
      await log.complete()
      return
    }

    if (!inboundText.trim() && inboundImages.length === 0) {
      await log.complete()
      return
    }

    const { messages, customerTexts } = await buildSalesAgentContext(
      db,
      conversationId,
    )
    const replyMode = detectReplyMode(
      [...customerTexts, inboundText].filter(Boolean),
    )
    const useSinglish = replyMode === 'singlish'
    log.set({
      ai_context: messages.map((m) => ({
        role: m.role,
        content: m.content.slice(0, 400),
      })),
      use_singlish: useSinglish,
      reply_mode: replyMode,
    })
    log.step(
      'context',
      `Built ${messages.length} compact turns; replyMode=${replyMode}`,
    )

    const { data: contact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .maybeSingle()
    const contactPhone =
      typeof contact?.phone === 'string' ? contact.phone : null

    const { products, customs } = await loadAgentCatalogs(db, accountId)
    const systemExtra = buildSessionStateExtra({
      orderPending: gate.conversation.sa_order_pending,
      identifyPending: gate.conversation.sa_identify_pending,
      inboundImages: inboundImages.length,
      burstText: inboundText,
    })

    const loopMessages = messages.length
      ? messages
      : inboundText
        ? [{ role: 'user' as const, content: inboundText }]
        : [{ role: 'user' as const, content: '[customer sent an image]' }]

    log.step(
      'ai_tools',
      `LLM decision maker ${config.provider}/${config.model} — ${loopMessages.length} msgs, ${products.length} products, ${customs.length} FAQ QRs, ${inboundImages.length} image(s)`,
    )

    const result = await runSalesAgentToolLoop({
      db,
      config,
      accountId,
      conversationId,
      contactId,
      configOwnerUserId,
      contactPhone,
      messages: loopMessages,
      systemExtra,
      useSinglish,
      replyMode,
      productCatalog: products,
      customCatalog: customs,
      inboundImages,
      burstText: inboundText,
      debug: log,
    })

    log.set({
      reply: {
        replied: result.replied,
        handoff: result.handoff,
        text: result.replyText?.slice(0, 500),
      },
      usage: result.usage,
    })
    log.step(
      'ai_result',
      result.handoff
        ? 'Model requested handoff / could not complete'
        : result.replied
          ? 'Agent tools handled the turn'
          : 'Agent produced no reply',
      {
        replied: result.replied,
        handoff: result.handoff,
        usage: result.usage,
      },
    )

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    })

    if (result.handoff || !result.replied) {
      const summary = buildHandoffSummary({
        messages: loopMessages,
        replyCount: gate.conversation.ai_reply_count ?? 0,
      })
      await db
        .from('conversations')
        .update({
          ai_autoreply_disabled: true,
          ai_handoff_summary: summary,
          ...(config.handoffAgentId
            ? { assigned_agent_id: config.handoffAgentId }
            : {}),
        })
        .eq('id', conversationId)
      try {
        await actionMarkHuman({
          db,
          accountId,
          conversationId,
          contactId,
          reason: result.handoff
            ? 'Agent handoff — Human'
            : 'Agent produced no reply — Human',
        })
        log.step('handoff', 'Tagged Human + paused AI for manual reply', {
          summary,
        })
      } catch {
        /* ignore */
      }
      await log.complete()
      return
    }

    if (result.replied) {
      if (inboundText) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
      }
      await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
    }
    await log.complete()
  } catch (err) {
    console.error('[sales-agent] dispatch failed:', err)
    await log.fail(err)
  }
}

function buildSessionStateExtra(args: {
  orderPending: unknown
  identifyPending: unknown
  inboundImages: number
  burstText: string
}): string {
  const lines: string[] = []
  lines.push(`Inbound image count this turn: ${args.inboundImages}`)
  if (args.burstText.trim()) {
    lines.push(`Latest burst text:\n${args.burstText.trim().slice(0, 800)}`)
  }

  const order = parseOrderPending(args.orderPending)
  if (order?.type === 'awaiting_address') {
    lines.push(
      `Saved bags awaiting address: ${order.items
        .map(
          (i) =>
            `${i.name}${i.color ? `/${i.color}` : ''} x${i.qty}`,
        )
        .join('; ')}`,
    )
  } else if (order?.type === 'awaiting_color') {
    lines.push(
      `Address on file; still need color for: ${(order.bags || [])
        .map((b) => b.name)
        .join(', ') || '(none yet)'}`,
    )
    if (order.addressText) {
      lines.push(`Saved address text: ${order.addressText.slice(0, 300)}`)
    }
  }

  const identify = parseIdentifyPending(args.identifyPending)
  if (identify) {
    lines.push(
      `Pending identify confirm: ${identify.product} / ${identify.color} (${identify.confidence.toFixed(0)}%) — if customer says yes, call identify_product or find_product; if no, ask which bag.`,
    )
  }

  return lines.join('\n')
}

async function claimSlot(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  maxReplies: number,
): Promise<boolean> {
  const { data: claimed, error } = await db.rpc('claim_ai_reply_slot', {
    conversation_id: conversationId,
    max_replies: maxReplies,
  })
  if (error) {
    console.error('[sales-agent] claim_ai_reply_slot failed:', error)
    return false
  }
  return claimed === true
}
