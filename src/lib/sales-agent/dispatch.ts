import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { logAiUsage } from '@/lib/ai/usage'
import { buildHandoffSummary } from '@/lib/ai/handoff'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import type { AiConfigWithSales, SalesAgentDispatchArgs } from './types'
import { parseSalesCapabilities, evaluateSalesAgentGates, stripTestMarker } from './gates'
import { buildSalesAgentContext } from './context'
import { shouldUseSinglish } from './language'
import {
  loadProductQuickReplies,
  matchProductsInText,
} from './match-products'
import {
  loadCustomQuickReplies,
  matchCustomQuickReplies,
} from './match-custom-qr'
import { sendQuickReplyByCatalogId, sendLocalTextQuickReply } from './send-quick-reply'
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
import { isAddressLikeMessage } from './actions/orders'
import { runSalesAgentToolLoop } from './tool-loop'

/**
 * Sales Agent entry — replaces plain AI auto-reply when sales_agent_enabled.
 * Never throws (webhook fire-and-forget safety).
 */
export async function dispatchSalesAgent(
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
  } = args

  try {
    const db = supabaseAdmin()
    const baseConfig = await loadAiConfig(db, accountId)
    if (!baseConfig || !baseConfig.autoReplyEnabled) return

    // Load capability flags (may be missing pre-migration — defaults apply)
    const { data: rawRow } = await db
      .from('ai_configs')
      .select(
        'sales_agent_enabled, sa_product_match, sa_identify, sa_custom_qr_match, sa_ai_text, sa_create_order, sa_quotation, sa_tracking, sa_edit_order',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    const caps = parseSalesCapabilities((rawRow ?? {}) as Record<string, unknown>)
    const config: AiConfigWithSales = { ...baseConfig, ...caps }

    if (!config.salesAgentEnabled) {
      // Fall back to legacy text-only auto-reply for text inbounds
      if (contentType === 'text' && rawInbound.trim()) {
        await dispatchInboundToAiReply({
          accountId,
          conversationId,
          contactId,
          configOwnerUserId,
        })
      }
      return
    }

    const gate = await evaluateSalesAgentGates(db, {
      accountId,
      conversationId,
      contactId,
      config,
    })
    if (!gate.ok) return

    // Stand down when message-level automations are active (same as auto-reply)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    if (gate.conversation.ai_reply_count >= config.autoReplyMaxPerConversation) {
      return
    }

    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) return

    const inboundText = stripTestMarker(rawInbound || '')
    const { messages, customerTexts } = await buildSalesAgentContext(
      db,
      conversationId,
    )
    const useSinglish = shouldUseSinglish([
      ...customerTexts,
      inboundText,
    ].filter(Boolean))

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
        handled = true
        await rememberAnsweredQuestion(db, conversationId, inboundText)
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
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
      })
      if (confirmed) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        return
      }
    }

    // 3) Dedup same question
    if (
      inboundText &&
      (await shouldSkipDuplicateQuestion(
        db,
        conversationId,
        inboundText,
        gate.conversation.sa_last_question_fp,
      ))
    ) {
      return
    }

    // 4) Image identify
    if (
      config.identify &&
      contentType === 'image' &&
      (mediaUrl || metaMediaId)
    ) {
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
      if (r.handled) {
        handled = true
        if (inboundText) {
          await rememberAnsweredQuestion(db, conversationId, inboundText)
        }
        await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
        // Continue if more text alongside — but typically image-only
        if (!inboundText.trim()) return
      }
    }

    // 5) Product name match → send product QRs
    if (config.productMatch && inboundText) {
      const products = await loadProductQuickReplies(db, accountId)
      const hits = matchProductsInText(inboundText, products)
      if (hits.length > 0) {
        for (const hit of hits.slice(0, 5)) {
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
          } catch (err) {
            console.error('[sales-agent] product QR send failed:', err)
          }
        }
      }
    }

    // 6) Custom QR description match (only if no product hit, or as extras)
    if (config.customQrMatch && inboundText && !handled) {
      const customs = await loadCustomQuickReplies(db, accountId)
      const matches = matchCustomQuickReplies(inboundText, customs, {
        minScore: 0.4,
      })
      const best = matches[0]
      if (best && best.score >= 0.45) {
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
          }
        } catch (err) {
          console.error('[sales-agent] custom QR send failed:', err)
        }
      }
    }

    if (handled) {
      if (inboundText) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
      }
      await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
      // Address-like messages with product already sent → let AI tools create order
      if (!(config.aiText && inboundText && isAddressLikeMessage(inboundText))) {
        return
      }
    }

    // 7) AI tool layer for residual questions / orders / tracking
    if (!config.aiText) return
    if (!inboundText.trim() && contentType !== 'image') return

    // Enrich context with identify note if we just processed an image
    const loopMessages = messages.length
      ? messages
      : inboundText
        ? [{ role: 'user' as const, content: inboundText }]
        : [{ role: 'user' as const, content: '[customer sent an image]' }]

    const [products, customs] = await Promise.all([
      loadProductQuickReplies(db, accountId),
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
      useSinglish,
      availableQuickReplies,
    })

    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage: result.usage,
    })

    if (result.handoff) {
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
      // Also apply Human tag when handing off
      try {
        const { actionMarkHuman } = await import('./actions/orders')
        await actionMarkHuman({
          db,
          accountId,
          conversationId,
          contactId,
          reason: 'AI handoff',
        })
      } catch {
        /* ignore */
      }
      return
    }

    if (result.replied) {
      if (inboundText) {
        await rememberAnsweredQuestion(db, conversationId, inboundText)
      }
      await claimSlot(db, conversationId, config.autoReplyMaxPerConversation)
    }
  } catch (err) {
    console.error('[sales-agent] dispatch failed:', err)
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
