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
  stripTestMarker,
} from './gates'
import { buildSalesAgentContext } from './context'
import {
  askBagAddressText,
  askWhichBagText,
  detectReplyMode,
} from './language'
import {
  loadProductQuickReplies,
  matchProductsInText,
} from './match-products'
import {
  loadCustomQuickReplies,
  matchCustomQuickReplies,
} from './match-custom-qr'
import {
  sendQuickReplyByCatalogId,
  sendLocalTextQuickReply,
} from './send-quick-reply'
import {
  handleInboundIdentify,
  parseIdentifyPending,
  resolveIdentifyConfirm,
} from './identify'
import {
  shouldSkipDuplicateQuestion,
  rememberAnsweredQuestion,
} from './dedupe'
import { maybeConfirmOrderTag } from './confirm-order-tag'
import {
  isAddressLikeMessage,
  actionCreateOrder,
  actionSendQuotation,
  actionMarkHuman,
} from './actions/orders'
import { runSalesAgentToolLoop } from './tool-loop'
import { SalesAgentRunLogger } from './debug-log'
import { engineSendText } from '@/lib/flows/meta-send'
import { fetchCatalogProduct } from '@/lib/catalog/products'
import {
  buildColorAskText,
  extractColorsFromText,
  extractOrderIntents,
  loadAlreadySentProductKeys,
  loadRecentCustomerTexts,
  parseColorOnlyReply,
  parseOrderPending,
  resolveLineItems,
  shouldRunOrderIntake,
  type OrderPendingState,
} from './order-intent'
import {
  isQuotationRequest,
  resolveQuotationItems,
} from './quotation-intent'

/**
 * Sales Agent entry — replaces plain AI auto-reply when sales_agent_enabled.
 * Never throws (webhook fire-and-forget safety).
 *
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

    let handled = false

    // 1) Pending identify confirmation
    const pending = parseIdentifyPending(gate.conversation.sa_identify_pending)
    if (pending && inboundText) {
      log.step('identify_confirm', 'Checking pending identify confirm', pending)
      const r = await resolveIdentifyConfirm({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        inboundText,
        pending,
        useSinglish,
      })
      if (r.handled) {
        log.step('identify_confirm', 'Customer confirmed/rejected identify')
        await rememberAnsweredQuestion(db, conversationId, inboundText)
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        await log.complete()
        return
      }
    }

    // 2) Order confirm (Pending → Confirmed)
    if (inboundText) {
      const confirmed = await maybeConfirmOrderTag({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        inboundText,
        useSinglish,
        replyMode,
      })
      if (confirmed) {
        log.step('order_tag', 'Pending → Confirmed (customer OK)')
        await rememberAnsweredQuestion(db, conversationId, inboundText)
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        await log.complete()
        return
      }
    }

    const products = await loadProductQuickReplies(db, accountId)
    const alreadySent = await loadAlreadySentProductKeys(
      db,
      conversationId,
      products,
    )
    const recentCustomerTexts = await loadRecentCustomerTexts(
      db,
      conversationId,
      12,
    )

    // 2c) Price / quotation request (bag names and/or images) → QuotationCard PNG
    if (config.quotation && isQuotationRequest(inboundText)) {
      log.step('quotation', 'Price/quotation intent detected', {
        images: inboundImages.length,
      })
      const { items, identified } = await resolveQuotationItems({
        db,
        accountId,
        inboundText,
        catalog: products,
        images: inboundImages,
      })
      log.step(
        'quotation',
        items.length
          ? `Resolved ${items.length} line item(s) for quotation`
          : 'No resolvable bags for quotation',
        { items, identified },
      )
      if (items.length > 0) {
        const r = await actionSendQuotation({
          db,
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          items,
          useSinglish,
        })
        log.step(
          'quotation',
          r.ok ? r.message : `Quotation failed: ${r.message}`,
        )
        if (r.ok) {
          await rememberAnsweredQuestion(db, conversationId, inboundText)
          await claimSlot(
            db,
            conversationId,
            config.autoReplyMaxPerConversation,
          )
          await log.complete()
          return
        }
      }
    }

    // 2b) Awaiting color for order — customer replies with a color
    const orderPending = parseOrderPending(gate.conversation.sa_order_pending)
    if (config.createOrder && orderPending && inboundText) {
      const colorOnly = parseColorOnlyReply(inboundText)
      const colorsInMsg = colorOnly
        ? [colorOnly]
        : extractColorsFromText(inboundText)
      if (colorsInMsg.length > 0) {
        const color = colorsInMsg[0]
        const intents = orderPending.bags.map((b) => ({
          productId: b.productId,
          catalogMessageId: b.catalogMessageId,
          name: b.name,
          color,
          qty: b.qty,
          quickReplyId: b.quickReplyId,
        }))
        const items = await resolveLineItems(intents)
        log.step('order', `Color "${color}" received — creating order`, {
          items,
        })
        const r = await actionCreateOrder({
          db,
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          addressText: orderPending.addressText,
          items,
          contactPhone,
          useSinglish,
        })
        await clearOrderPending(db, conversationId)
        log.step('order', r.ok ? r.message : `Create failed: ${r.message}`)
        if (r.ok) {
          await rememberAnsweredQuestion(db, conversationId, inboundText)
          await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
          await log.complete()
          return
        }
      }
    }

    // 2c) Address intake → create order (or ask color). Skip re-sending product QRs.
    if (config.createOrder && inboundText && shouldRunOrderIntake(inboundText)) {
      const intents = extractOrderIntents(
        [inboundText, ...recentCustomerTexts],
        products,
      )
      log.step('order', 'Address-like message — resolving bag/color intents', {
        intents,
      })

      const missingColor = intents.filter((i) => !i.color)
      const ready = intents.filter((i) => i.color)

      if (intents.length === 0) {
        log.step(
          'order',
          'Address found but no bag in recent messages — asking which bag',
        )
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: askWhichBagText(replyMode),
          aiGenerated: true,
        })
        handled = true
        await rememberAnsweredQuestion(db, conversationId, inboundText)
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        await log.complete()
        return
      }

      if (missingColor.length > 0 && ready.length === 0) {
        // All bags missing color — ask, keep address for later
        let availableColors: string[] = []
        const first = missingColor[0]
        if (first.productId) {
          try {
            const p = await fetchCatalogProduct(first.productId)
            availableColors = p?.colors ?? []
          } catch {
            /* ignore */
          }
        }
        const pending: OrderPendingState = {
          type: 'awaiting_color',
          bags: missingColor.map((b) => ({
            productId: b.productId,
            catalogMessageId: b.catalogMessageId,
            name: b.name,
            qty: b.qty,
            quickReplyId: b.quickReplyId,
          })),
          addressText: inboundText,
          askedAt: new Date().toISOString(),
        }
        await db
          .from('conversations')
          .update({ sa_order_pending: pending })
          .eq('id', conversationId)
        const ask = buildColorAskText(missingColor, useSinglish, availableColors)
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: ask,
          aiGenerated: true,
        })
        log.step('order', 'Asked for color before creating order', { ask })
        await rememberAnsweredQuestion(db, conversationId, inboundText)
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        await log.complete()
        return
      }

      // Prefer ready (with color) items; if mix, create for ready and ask for rest later
      const toCreate = ready.length ? ready : intents
      if (toCreate.every((i) => i.color)) {
        const items = await resolveLineItems(toCreate)
        const r = await actionCreateOrder({
          db,
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          addressText: inboundText,
          items,
          contactPhone,
          useSinglish,
        })
        await clearOrderPending(db, conversationId)
        log.step(
          'order',
          r.ok ? `Order created: ${r.message}` : `Create failed: ${r.message}`,
          { items },
        )
        if (r.ok) {
          await rememberAnsweredQuestion(db, conversationId, inboundText)
          await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
          await log.complete()
          return
        }
      }
    }

    // 3) Dedup same question (skip when address intake already handled)
    if (
      inboundText &&
      (await shouldSkipDuplicateQuestion(
        db,
        conversationId,
        inboundText,
        gate.conversation.sa_last_question_fp,
      ))
    ) {
      await log.skip(
        'duplicate_question',
        'Same question fingerprint as last answered — skipped reply',
      )
      return
    }

    // 4) Image identify
    if (
      config.identify &&
      contentType === 'image' &&
      (mediaUrl || metaMediaId)
    ) {
      log.step('identify', 'Running bag identify on inbound image')
      const r = await handleInboundIdentify({
        db,
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
        mediaUrl,
        metaMediaId,
        useSinglish,
      })
      log.set({
        identify: {
          handled: r.handled,
          sentQr: r.sentQr,
        },
      })
      log.step(
        'identify',
        r.handled
          ? r.sentQr
            ? 'Identify ≥90% — sent product QR'
            : 'Identify <90% — asked customer to confirm'
          : 'Identify produced no actionable match',
        { handled: r.handled, sentQr: r.sentQr },
      )
      if (r.handled) {
        handled = true
        if (inboundText) {
          await rememberAnsweredQuestion(db, conversationId, inboundText)
        }
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        if (!inboundText.trim()) {
          await log.complete()
          return
        }
      }
    }

    // 5) Product name match → send each relevant product QR (skip already sent)
    if (config.productMatch && inboundText && !isAddressLikeMessage(inboundText)) {
      const hits = matchProductsInText(inboundText, products)
      const freshHits = hits.filter((h) => {
        const key = h.catalog_message_id || h.id
        return !alreadySent.has(key)
      })
      const skipped = hits.filter((h) => {
        const key = h.catalog_message_id || h.id
        return alreadySent.has(key)
      })
      log.set({
        product_hits: hits.map((h) => ({
          title: h.title,
          catalog_message_id: h.catalog_message_id,
        })),
      })
      if (skipped.length) {
        log.step(
          'product_match',
          `Skipped already-sent product QR(s): ${skipped.map((s) => s.title).join(', ')}`,
        )
      }
      log.step(
        'product_match',
        freshHits.length
          ? `Matched ${freshHits.length} product QR(s)${isFirstInboundMessage ? ' (first inbound)' : ''}`
          : hits.length
            ? 'Product named but QR already sent — not resending'
            : 'No product name match',
        { titles: freshHits.map((h) => h.title) },
      )
      if (freshHits.length > 0) {
        // One QR fully complete (all images) before the next — queue inside
        // sendQuickReplyByCatalogId also serializes concurrent callers.
        for (const hit of freshHits.slice(0, 8)) {
          if (!hit.catalog_message_id) continue
          try {
            await sendQuickReplyByCatalogId({
              db,
              accountId,
              conversationId,
              catalogMessageId: hit.catalog_message_id,
              contextSummary:
                hit.description?.trim() ||
                `Sent product quick reply: ${hit.title}`,
            })
            handled = true
            log.step('send_qr', `Sent product QR: ${hit.title}`, {
              catalog_message_id: hit.catalog_message_id,
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log.step('send_qr', `Product QR failed: ${msg}`, { title: hit.title })
            console.error('[sales-agent] product QR send failed:', err)
          }
        }
      } else if (hits.length > 0 && skipped.length > 0) {
        const intents = extractOrderIntents([inboundText], products)
        const withColor = intents.filter((i) => i.color)
        if (withColor.length && config.createOrder) {
          const ask = askBagAddressText(replyMode)
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: ask,
            aiGenerated: true,
          })
          handled = true
          log.step('order', 'Bag already sent + color chosen — asked for address')
        }
      }
    }

    // 6) Custom / other QR (non-product questions)
    if (config.customQrMatch && inboundText && !handled) {
      const customs = await loadCustomQuickReplies(db, accountId)
      const matches = matchCustomQuickReplies(inboundText, customs, {
        minScore: 0.4,
      })
      const best = matches[0]
      log.set({
        custom_qr_match: best
          ? { title: best.qr.title, score: best.score }
          : null,
      })
      if (best && best.score >= 0.45) {
        log.step(
          'custom_qr',
          `Matched custom QR "${best.qr.title}" score=${best.score.toFixed(2)}`,
        )
        try {
          if (best.qr.catalog_message_id) {
            await sendQuickReplyByCatalogId({
              db,
              accountId,
              conversationId,
              catalogMessageId: best.qr.catalog_message_id,
              contextSummary:
                best.qr.description || `Sent custom QR: ${best.qr.title}`,
            })
            handled = true
            log.step('send_qr', `Sent custom catalog QR: ${best.qr.title}`)
          } else if (best.qr.kind === 'text' && best.qr.content_text) {
            await sendLocalTextQuickReply({
              db,
              accountId,
              userId: configOwnerUserId,
              conversationId,
              contactId,
              text: best.qr.content_text,
              contextSummary:
                best.qr.description || `Sent quick reply: ${best.qr.title}`,
            })
            handled = true
            log.step('send_qr', `Sent local text QR: ${best.qr.title}`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.step('send_qr', `Custom QR failed: ${msg}`)
          console.error('[sales-agent] custom QR send failed:', err)
        }
      } else {
        log.step('custom_qr', 'No strong custom QR description match')
      }
    }

    if (handled) {
      if (inboundText) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
      }
      await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
      if (!(config.aiText && inboundText && isAddressLikeMessage(inboundText))) {
        log.step('done', 'Quick reply layer handled — skipping AI free-text')
        await log.complete()
        return
      }
      log.step(
        'ai_tools',
        'Deterministic handled but address-like — continuing to AI tools',
      )
    }

    // 7) AI picks QRs only; if none fit → Human for manual reply
    if (!config.aiText) {
      if (!handled && (inboundText.trim() || contentType === 'image')) {
        await actionMarkHuman({
          db,
          accountId,
          conversationId,
          contactId,
          reason: 'No suitable quick reply matched; AI text off',
        })
        log.step(
          'handoff',
          'No QR match + AI off — tagged Human for manual reply',
        )
      } else {
        log.step('ai_tools', 'AI text/tools capability off — stop')
      }
      await log.complete()
      return
    }
    if (!inboundText.trim() && contentType !== 'image') {
      await log.complete()
      return
    }

    const loopMessages = messages.length
      ? messages
      : inboundText
        ? [{ role: 'user' as const, content: inboundText }]
        : [{ role: 'user' as const, content: '[customer sent an image]' }]

    const [customs] = await Promise.all([
      loadCustomQuickReplies(db, accountId),
    ])
    const availableQuickReplies = [
      ...products.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        catalog_message_id: p.catalog_message_id,
      })),
      ...customs.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        catalog_message_id: c.catalog_message_id,
      })),
    ]
    log.step(
      'ai_tools',
      `Calling ${config.provider}/${config.model} with ${loopMessages.length} msgs, ${availableQuickReplies.length} QRs listed`,
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
      systemExtra: '',
      useSinglish: replyMode === 'singlish',
      replyMode,
      availableQuickReplies,
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
        ? 'Model requested handoff / no suitable QR'
        : result.replied
          ? 'AI sent quick reply / ran tools'
          : 'AI produced no reply',
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
            ? 'No suitable quick reply — Human'
            : 'AI produced no quick reply — Human',
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

async function clearOrderPending(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
): Promise<void> {
  await db
    .from('conversations')
    .update({ sa_order_pending: null })
    .eq('id', conversationId)
}
