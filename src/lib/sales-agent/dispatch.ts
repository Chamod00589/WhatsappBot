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
import { actionMarkHuman, isAddressLikeMessage } from './actions/orders'
import { runSalesAgentToolLoop } from './tool-loop'
import { loadAgentCatalogs } from './tool-executors'
import { extractCartIntent } from './cart-intent-extract'
import { runCartPipeline } from './cart-pipeline'
import { SalesAgentRunLogger } from './debug-log'
import { rememberAnsweredQuestion } from './dedupe'
import type { AiUsage } from '@/lib/ai/types'
import {
  applyReplyReferenceToPending,
  resolveReplyReference,
} from './reply-reference'
import { markAgentUnableToReply, removeNamedTag } from './tags'
import { formatAdReferralForAgent, withAdReferralText } from './referral'
import { hasSentAddressRequestQr } from './address-request-qr'

/**
 * Sales Agent entry — extract→validate→quote for carts; tool loop for FAQ/identify.
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

  const replyToMessageId =
    typeof args.replyToMessageId === 'string' && args.replyToMessageId.trim()
      ? args.replyToMessageId.trim()
      : null

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
    hasAdReferral: Boolean(
      args.referral &&
        typeof args.referral === 'object' &&
        Object.keys(args.referral).length > 0,
    ),
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

    const forceManual = args.forceManual === true

    const gate = await evaluateSalesAgentGates(db, {
      accountId,
      conversationId,
      contactId,
      config,
      forceManual,
    })
    if (!gate.ok) {
      await log.skip(gate.reason, `Gate blocked: ${gate.reason}`)
      return
    }
    log.step('gate', 'Passed eligibility gates', {
      ai_reply_count: gate.conversation.ai_reply_count,
      has_identify_pending: Boolean(gate.conversation.sa_identify_pending),
      has_order_pending: Boolean(gate.conversation.sa_order_pending),
      forceManual,
    })

    if (!forceManual) {
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
    } else {
      log.step('gate', 'Manual inbox Reply-with-AI — skipped automation/reply-cap gates')
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
    const referral =
      args.referral &&
      typeof args.referral === 'object' &&
      Object.keys(args.referral).length > 0
        ? args.referral
        : null
    // Burst text for product matchers + tools includes ad copy so a
    // generic greeting still resolves to the advertised bag.
    const burstText = withAdReferralText(inboundText, referral) || inboundText
    const adBlurb = formatAdReferralForAgent(referral)

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
      if (inboundText.trim() || inboundImages.length > 0 || adBlurb) {
        await actionMarkHuman({
          db,
          accountId,
          conversationId,
          contactId,
          reason: 'Sales Agent AI decision layer off (sa_ai_text)',
        })
        await markAgentUnableToReply({
          db,
          accountId,
          conversationId,
          contactId,
          ownerUserId: configOwnerUserId,
        })
        log.step(
          'handoff',
          'AI decision layer off — tagged Human + Unread for manual reply',
        )
      } else {
        log.step('ai_tools', 'AI decision layer off — stop')
      }
      await log.complete()
      return
    }

    if (!inboundText.trim() && inboundImages.length === 0 && !adBlurb) {
      await log.complete()
      return
    }

    const { messages, customerTexts } = await buildSalesAgentContext(
      db,
      conversationId,
    )
    const replyMode = detectReplyMode(
      [...customerTexts, burstText].filter(Boolean),
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

    // Swipe-reply to a product QR image ("me color eken") → resolve that
    // image's bag+color and overwrite older identify memory (e.g. Brown→White).
    let replyRefNote = ''
    let orderPendingForExtra = gate.conversation.sa_order_pending
    if (replyToMessageId && inboundText.trim()) {
      try {
        const ref = await resolveReplyReference({
          db,
          accountId,
          conversationId,
          replyToMessageId,
          inboundText,
        })
        if (ref?.productName) {
          await applyReplyReferenceToPending({
            db,
            conversationId,
            ref,
          })
          const { data: convFresh } = await db
            .from('conversations')
            .select('sa_order_pending')
            .eq('id', conversationId)
            .maybeSingle()
          orderPendingForExtra = convFresh?.sa_order_pending ?? orderPendingForExtra
          replyRefNote =
            `Customer swipe-replied to a product message — use THIS bag/color (not an older identify):\n` +
            `${ref.productName} / ${ref.color || '—'} x${ref.qty || 1} (source=${ref.source}).`
          log.step('reply_ref', replyRefNote, ref)
        } else {
          log.step(
            'reply_ref',
            'Customer replied to a message but no bag/color could be resolved',
            { replyToMessageId },
          )
        }
      } catch (err) {
        console.warn('[sales-agent] reply reference resolve failed:', err)
        log.step(
          'reply_ref',
          `Reply resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const addressQrAlreadySent = await hasSentAddressRequestQr(
      db,
      conversationId,
    )
    let systemExtra = [
      buildSessionStateExtra({
        orderPending: orderPendingForExtra,
        identifyPending: gate.conversation.sa_identify_pending,
        inboundImages: inboundImages.length,
        burstText,
        adReferral: adBlurb,
        addressQrAlreadySent,
      }),
      replyRefNote,
    ]
      .filter(Boolean)
      .join('\n\n')

    const loopMessages = messages.length
      ? messages
      : burstText
        ? [{ role: 'user' as const, content: burstText }]
        : [{ role: 'user' as const, content: '[customer sent an image]' }]

    // Extract → validate → quote pipeline (LLM extracts JSON only; server owns cart).
    let cartHandled = false
    let extractUsage: AiUsage | null = null
    if (
      (config.quotation || config.editOrder) &&
      burstText.trim() &&
      config.aiText
    ) {
      try {
        log.step('cart_extract', 'Extracting cart intent (JSON only)')
        const extracted = await extractCartIntent({
          config,
          messages: loopMessages,
          burstText,
          sessionExtra: systemExtra,
          productCatalog: products,
        })
        extractUsage = extracted.usage
        log.step(
          'cart_extract',
          `intent=${extracted.extraction.intent} op=${extracted.extraction.operation || 'null'} items=${extracted.extraction.items.length}`,
          extracted.extraction,
        )

        if (
          extracted.extraction.intent === 'quotation' ||
          extracted.extraction.intent === 'edit_cart' ||
          // Color-only / heuristic path inside pipeline even when LLM says none
          Boolean(burstText.trim())
        ) {
          const pipe = await runCartPipeline({
            db,
            accountId,
            conversationId,
            contactId,
            configOwnerUserId,
            contactPhone,
            extraction: extracted.extraction,
            productCatalog: products,
            useSinglish,
            replyMode,
            quotationEnabled: Boolean(config.quotation),
            editOrderEnabled: Boolean(config.editOrder),
            burstText,
          })
          cartHandled = pipe.handled
          log.step(
            'cart_pipeline',
            pipe.message,
            {
              handled: pipe.handled,
              quoted: pipe.quoted,
              clarified: pipe.clarified,
              updated: pipe.updated,
              clarifyReason: pipe.clarifyReason,
            },
          )
          if (pipe.handled) {
            systemExtra = [
              systemExtra,
              `Cart pipeline already handled this turn: quoted=${pipe.quoted} clarified=${pipe.clarified} updated=${pipe.updated}. Do not invent products/prices. Continue only for FAQ, identify images, address→create_order, tracking, or handoff.`,
            ]
              .filter(Boolean)
              .join('\n\n')

            // Refresh pending for session after cart update
            const { data: convAfterCart } = await db
              .from('conversations')
              .select('sa_order_pending')
              .eq('id', conversationId)
              .maybeSingle()
            orderPendingForExtra =
              convAfterCart?.sa_order_pending ?? orderPendingForExtra
          }
        }
      } catch (err) {
        console.warn('[sales-agent] cart pipeline failed:', err)
        log.step(
          'cart_pipeline',
          `Cart pipeline error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // If cart clarified/quoted and there is no image / no other work needed,
    // still allow tool loop for address/FAQ/identify — but skip when image-less
    // and cart already replied unless the burst looks like an address.
    const likelyAddress = isAddressLikeMessage(burstText)
    const skipToolLoop =
      cartHandled &&
      inboundImages.length === 0 &&
      !likelyAddress &&
      !adBlurb

    if (skipToolLoop) {
      log.step(
        'ai_tools',
        'Skipped tool loop — cart pipeline already replied (no images/address)',
      )
      if (extractUsage) {
        void logAiUsage(db, {
          accountId,
          conversationId,
          mode: 'auto_reply',
          provider: config.provider,
          model: config.model,
          usage: extractUsage,
        })
      }
      if (inboundText) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
      }
      await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
      try {
        await removeNamedTag(db, accountId, contactId, 'Unread')
      } catch {
        /* ignore */
      }
      await log.complete()
      return
    }

    log.step(
      'ai_tools',
      `LLM FAQ/identify layer ${config.provider}/${config.model} — ${loopMessages.length} msgs, ${products.length} products, ${customs.length} FAQ QRs, ${inboundImages.length} image(s)`,
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
      burstText,
      debug: log,
    })

    // Prefer tool-loop usage; fall back to extract usage.
    const usage = result.usage || extractUsage

    log.set({
      reply: {
        replied: result.replied || cartHandled,
        handoff: result.handoff,
        text: result.replyText?.slice(0, 500),
      },
      usage,
    })
    log.step(
      'ai_result',
      result.handoff
        ? 'Model requested handoff / could not complete'
        : result.replied || cartHandled
          ? 'Agent handled the turn'
          : 'Agent produced no reply',
      {
        replied: result.replied || cartHandled,
        handoff: result.handoff,
        cartHandled,
        usage,
      },
    )

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (result.handoff || (!result.replied && !cartHandled)) {
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
        await markAgentUnableToReply({
          db,
          accountId,
          conversationId,
          contactId,
          ownerUserId: configOwnerUserId,
        })
        log.step(
          'handoff',
          'Tagged Human + Unread + paused AI for manual reply',
          { summary },
        )
      } catch {
        /* ignore */
      }
      await log.complete()
      return
    }

    if (result.replied || cartHandled) {
      if (inboundText) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
      }
      await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
      try {
        await removeNamedTag(db, accountId, contactId, 'Unread')
      } catch {
        /* ignore */
      }
    }
    await log.complete()
  } catch (err) {
    console.error('[sales-agent] dispatch failed:', err)
    try {
      await markAgentUnableToReply({
        db,
        accountId,
        conversationId,
        contactId,
        ownerUserId: configOwnerUserId,
      })
      await actionMarkHuman({
        db,
        accountId,
        conversationId,
        contactId,
        reason: `Agent error — ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          200,
        ),
      })
      log.step('handoff', 'Dispatch error — tagged Human + Unread')
    } catch {
      /* ignore secondary failures */
    }
    await log.fail(err)
  }
}

function buildSessionStateExtra(args: {
  orderPending: unknown
  identifyPending: unknown
  inboundImages: number
  burstText: string
  adReferral?: string | null
  addressQrAlreadySent?: boolean
}): string {
  const lines: string[] = []
  lines.push(`Inbound image count this turn: ${args.inboundImages}`)
  if (args.addressQrAlreadySent) {
    lines.push(
      'Address Quick Reply already sent this chat — do NOT re-send unless customer asks address format / how to order again.',
    )
  } else {
    lines.push(
      'Address Quick Reply not sent yet — server will auto-send it once after the first quotation.',
    )
  }
  if (args.adReferral?.trim()) {
    lines.push(args.adReferral.trim().slice(0, 900))
  }
  if (args.burstText.trim()) {
    lines.push(`Latest burst text:\n${args.burstText.trim().slice(0, 1200)}`)
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
