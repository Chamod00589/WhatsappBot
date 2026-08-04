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
import { parseIdentifyPending, handleInboundIdentifyMany } from './identify'
import { parseOrderPending } from './order-intent'
import { actionMarkHuman, isAddressLikeMessage } from './actions/orders'
import { runSalesAgentToolLoop } from './tool-loop'
import { loadAgentCatalogs } from './tool-executors'
import { extractCartIntent } from './cart-intent-extract'
import { runCartPipeline } from './cart-pipeline'
import { maybeSendProductDetailsQr, isProductDetailsOrColorsAsk } from './product-details-qr'
import { isQuotationRequest } from './quotation-intent'
import { findRecentOrderForPhone, isAddToOrderRequest } from './order-edit-intent'
import { SalesAgentRunLogger } from './debug-log'
import { rememberAnsweredQuestion } from './dedupe'
import type { AiUsage } from '@/lib/ai/types'
import {
  applyReplyReferenceToPending,
  resolveReplyReference,
  shouldApplyReplyRefToPending,
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
  await log.flushNow()

  // Fail the debug run if the whole dispatch hangs (e.g. catalog API).
  const DISPATCH_WATCHDOG_MS = 150_000
  let dispatchSettled = false
  const watchdog = setTimeout(() => {
    if (dispatchSettled) return
    console.error(
      '[sales-agent] dispatch watchdog — still running after',
      DISPATCH_WATCHDOG_MS,
      'ms',
    )
    void log.fail(
      new Error(
        `Sales Agent hung after ${Math.round(DISPATCH_WATCHDOG_MS / 1000)}s (last phase may show where it stuck)`,
      ),
    )
  }, DISPATCH_WATCHDOG_MS)

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
          // Color-pick swipe → update pending. Add ("ekath") → note only
          // so cart extract does not double-count qty.
          if (shouldApplyReplyRefToPending(inboundText)) {
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
            orderPendingForExtra =
              convFresh?.sa_order_pending ?? orderPendingForExtra
          }
          replyRefNote =
            `Customer swipe-replied to a product message — use THIS bag/color (not an older identify):\n` +
            `${ref.productName} / ${ref.color || '—'} x${ref.qty || 1} (source=${ref.source}).` +
            (isAddToOrderRequest(inboundText)
              ? '\nThis is an ADD request — include this bag once at qty 1 unless they stated another count.'
              : '')
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

    // Live order lines for edit context (after create_order pending is cleared).
    let liveOrderLinesNote = ''
    if (config.editOrder && contactPhone) {
      try {
        const recent = await findRecentOrderForPhone(contactPhone)
        if (recent) {
          const items = Array.isArray(recent.order.items)
            ? (recent.order.items as Array<{
                productId?: string
                name?: string
                color?: string
                quantity?: number
              }>)
            : []
          if (items.length) {
            liveOrderLinesNote =
              `CURRENT LIVE ORDER ${recent.id} (authoritative for edit_cart / color swap / remove):\n` +
              items
                .map(
                  (it) =>
                    `${it.name || 'Bag'}${it.color ? ` / ${it.color}` : ''} x${Math.max(1, Number(it.quantity) || 1)}` +
                    (it.productId ? ` [id=${it.productId}]` : ''),
                )
                .join('\n') +
              '\nWhen customer changes color/qty/remove, edit THIS order — do not invent other bags from old screenshots.'
          }
        }
      } catch {
        /* ignore */
      }
    }

    let systemExtra = [
      buildSessionStateExtra({
        orderPending: orderPendingForExtra,
        identifyPending: gate.conversation.sa_identify_pending,
        inboundImages: inboundImages.length,
        burstText,
        adReferral: adBlurb,
        addressQrAlreadySent,
        liveOrderLinesNote,
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

    // ── 1) Identify inbound images FIRST (before cart extract) ──────────
    // So "this bag" can resolve to the photo product, and we only quote once
    // after text+photo bags are merged.
    let identifyAlreadyDone = false
    let quoteSentThisTurn = false
    let identifyHandled = false
    if (config.identify && inboundImages.length > 0) {
      try {
        log.step(
          'identify',
          `Identifying ${inboundImages.length} inbound image(s) before cart`,
        )
        const idResult = await handleInboundIdentifyMany({
          db,
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
          images: inboundImages,
          burstText,
          useSinglish,
        })
        identifyAlreadyDone = true
        identifyHandled = idResult.handled
        const identifyPayload = {
          identified: idResult.identified,
          sentQr: idResult.sentQr,
          qrCount: idResult.qrCount,
          savedItems: (idResult.savedItems || []).map((it) => ({
            productId: it.productId,
            name: it.name,
            color: it.color,
            qty: it.qty,
            price: it.price,
          })),
        }
        log.set({ identify: identifyPayload })
        log.step(
          'identify',
          idResult.sentQr
            ? `identified + sent ${idResult.qrCount} product card(s); saved ${(idResult.savedItems || []).length} line(s)`
            : idResult.handled
              ? 'identified — asked customer to confirm'
              : idResult.identified.length
                ? 'identified (no high-confidence QR yet)'
                : 'no identify match',
          identifyPayload,
        )
        await log.flushNow()

        if (idResult.identified.length) {
          const photoLines = idResult.identified
            .map((m) => {
              const colorPart = m.colorKnown && m.color
                ? m.color
                : 'color unknown'
              return `${m.product} / ${colorPart} (${m.confidence.toFixed(0)}%)`
            })
            .join('; ')
          systemExtra = [
            systemExtra,
            `PHOTO IDENTIFIED this turn (authoritative for "this bag" / "me bag" / "meka"):\n${photoLines}`,
            idResult.savedItems?.length
              ? `Saved after identify: ${idResult.savedItems
                  .map(
                    (i) =>
                      `${i.name}${i.color ? `/${i.color}` : ''} x${i.qty}`,
                  )
                  .join('; ')}`
              : '',
            'Images already identified + product cards sent when matched. Do NOT call identify_product again this turn. Cart pipeline will send at most one quotation.',
          ]
            .filter(Boolean)
            .join('\n\n')
        }

        // Refresh pending after identify merge
        const { data: convAfterId } = await db
          .from('conversations')
          .select('sa_order_pending, sa_identify_pending')
          .eq('id', conversationId)
          .maybeSingle()
        orderPendingForExtra =
          convAfterId?.sa_order_pending ?? orderPendingForExtra
        if (convAfterId) {
          gate.conversation.sa_identify_pending =
            convAfterId.sa_identify_pending
        }
      } catch (err) {
        console.warn('[sales-agent] early identify failed:', err)
        log.step(
          'identify',
          `Identify failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // ── 1b) Photo/details ask → Details QR only (no quotation) ──────────
    let productDetailsHandled = false
    const detailsOnlyAsk =
      Boolean(burstText.trim()) &&
      isProductDetailsOrColorsAsk(burstText) &&
      !isQuotationRequest(burstText) &&
      !isAddToOrderRequest(burstText) &&
      !/\b(ganna|ganne|oni|onne|buy|order\s+eka)\b/i.test(burstText)

    if (config.productMatch && detailsOnlyAsk) {
      try {
        const details = await maybeSendProductDetailsQr({
          db,
          accountId,
          conversationId,
          burstText,
          orderPending: orderPendingForExtra,
          productCatalog: products,
          forceResend: true,
        })
        if (details.sent) {
          productDetailsHandled = true
          log.step('product_details_qr', details.note, {
            productName: details.productName,
          })
          systemExtra = [
            systemExtra,
            `Product Details QR already sent this turn for ${details.productName || 'bag'} (photos/colors/details ask). Do NOT quote. Do NOT call answer_policy for product colors.`,
          ]
            .filter(Boolean)
            .join('\n\n')
        } else if (details.note && !details.note.startsWith('not a')) {
          log.step('product_details_qr', details.note)
        }
      } catch (err) {
        console.warn('[sales-agent] product details QR (early) failed:', err)
        log.step(
          'product_details_qr',
          `failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // ── 2) Cart extract → validate → quote (uses identify results above) ─
    let cartHandled = false
    let extractUsage: AiUsage | null = null
    if (
      !productDetailsHandled &&
      (config.quotation || config.editOrder) &&
      burstText.trim() &&
      config.aiText
    ) {
      try {
        log.step('cart_extract', 'Extracting cart intent (JSON only)')
        await log.flushNow()
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
          const recentCustomerMsgs = loopMessages
            .filter((m) => m.role === 'user')
            .map((m) => m.content)
            .slice(-6)
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
            aiConfig: config,
            recentCustomerMsgs,
          })
          cartHandled = pipe.handled
          if (pipe.quoted) quoteSentThisTurn = true
          log.step(
            'cart_pipeline',
            pipe.message,
            {
              handled: pipe.handled,
              quoted: pipe.quoted,
              clarified: pipe.clarified,
              updated: pipe.updated,
              clarifyReason: pipe.clarifyReason,
              verify: pipe.verify || null,
            },
          )
          if (pipe.handled) {
            systemExtra = [
              systemExtra,
              `Cart pipeline already handled this turn: quoted=${pipe.quoted} clarified=${pipe.clarified} updated=${pipe.updated}. Do not invent products/prices. Continue only for FAQ, address→create_order, tracking, or handoff.`,
              pipe.quoted
                ? 'Quotation already sent this turn — do NOT call identify_product or generate another quote.'
                : '',
              pipe.updated && !pipe.quoted && isAddressLikeMessage(burstText)
                ? 'Customer sent address this turn — cart was saved WITHOUT a quotation. Call create_order with address_text only. Do NOT call generate_quote / send another quotation. Order confirm includes bags, prices, and shipping.'
                : '',
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

    // Product colors/details ask → send that bag's Details QR (not custom FAQ).
    // Prefer pending/quoted "me bag". Skip if early details-only path already sent.
    if (config.productMatch && burstText.trim() && !productDetailsHandled) {
      try {
        const details = await maybeSendProductDetailsQr({
          db,
          accountId,
          conversationId,
          burstText,
          orderPending: orderPendingForExtra,
          productCatalog: products,
          forceResend: true,
        })
        if (details.sent) {
          productDetailsHandled = true
          log.step('product_details_qr', details.note, {
            productName: details.productName,
          })
          systemExtra = [
            systemExtra,
            `Product Details QR already sent this turn for ${details.productName || 'bag'} (colors/details ask). Do NOT call answer_policy for product colors.`,
          ]
            .filter(Boolean)
            .join('\n\n')
        } else if (details.note && !details.note.startsWith('not a')) {
          log.step('product_details_qr', details.note)
        }
      } catch (err) {
        console.warn('[sales-agent] product details QR failed:', err)
        log.step(
          'product_details_qr',
          `failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // If cart clarified/quoted and there is no more work, skip the tool loop.
    // Images already identified above — don't re-enter just to identify again.
    const likelyAddress = isAddressLikeMessage(burstText)
    const skipToolLoop =
      (cartHandled || productDetailsHandled) &&
      (inboundImages.length === 0 || identifyAlreadyDone) &&
      !likelyAddress &&
      !adBlurb

    if (skipToolLoop) {
      log.step(
        'ai_tools',
        productDetailsHandled
          ? 'Skipped tool loop — product Details QR sent for colors/details ask'
          : identifyAlreadyDone && cartHandled
            ? 'Skipped tool loop — identify + cart already handled this turn'
            : 'Skipped tool loop — cart pipeline already replied (no address/FAQ needed)',
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
      inboundImages: identifyAlreadyDone ? [] : inboundImages,
      burstText,
      debug: log,
      quoteSentThisTurn,
      identifyAlreadyDone,
    })

    // Prefer tool-loop usage; fall back to extract usage.
    const usage = result.usage || extractUsage

    log.set({
      reply: {
        replied:
          result.replied ||
          cartHandled ||
          productDetailsHandled ||
          identifyHandled,
        handoff: result.handoff,
        text: result.replyText?.slice(0, 500),
      },
      usage,
    })
    log.step(
      'ai_result',
      result.handoff
        ? 'Model requested handoff / could not complete'
        : result.replied ||
            cartHandled ||
            productDetailsHandled ||
            identifyHandled
          ? 'Agent handled the turn'
          : 'Agent produced no reply',
      {
        replied:
          result.replied ||
          cartHandled ||
          productDetailsHandled ||
          identifyHandled,
        handoff: result.handoff,
        cartHandled,
        identifyHandled,
        identifyAlreadyDone,
        quoteSentThisTurn,
        productDetailsHandled,
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

    if (
      result.handoff ||
      (!result.replied &&
        !cartHandled &&
        !productDetailsHandled &&
        !identifyHandled)
    ) {
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

    if (
      result.replied ||
      cartHandled ||
      productDetailsHandled ||
      identifyHandled
    ) {
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
  } finally {
    dispatchSettled = true
    clearTimeout(watchdog)
  }
}

function buildSessionStateExtra(args: {
  orderPending: unknown
  identifyPending: unknown
  inboundImages: number
  burstText: string
  adReferral?: string | null
  addressQrAlreadySent?: boolean
  liveOrderLinesNote?: string
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
      `SELECTED BAGS (quotation cart — use for add/remove/qty/color before order):\n${order.items
        .map(
          (i) =>
            `${i.name}${i.color ? `/${i.color}` : ''} x${i.qty}` +
            (i.productId ? ` [id=${i.productId}]` : ''),
        )
        .join('\n')}`,
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

  if (args.liveOrderLinesNote?.trim()) {
    lines.push(args.liveOrderLinesNote.trim())
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
