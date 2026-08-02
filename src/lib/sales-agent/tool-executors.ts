import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrderLineItem } from '@/lib/orders/constants'
import { engineSendText } from '@/lib/flows/meta-send'
import {
  actionCreateOrder,
  actionEditOrder,
  actionMarkHuman,
  actionSendQuotation,
  actionSendTracking,
} from './actions/orders'
import { maybeConfirmOrderTag } from './confirm-order-tag'
import {
  handleInboundIdentifyMany,
  identifyInboundImage,
  parseIdentifyPending,
  resolveIdentifyConfirm,
} from './identify'
import {
  findCustomQuickReply,
  loadCustomQuickReplies,
  type CustomQuickReply,
} from './match-custom-qr'
import {
  loadProductQuickReplies,
  matchProductByIdentifyName,
  matchProductsInText,
  type MatchableQuickReply,
} from './match-products'
import {
  parseOrderPending,
  productDisplayName,
  resolveLineItems,
  toPendingQuotedItems,
  upsertAwaitingAddressItems,
  type BagOrderIntent,
  type OrderPendingQuotedItem,
} from './order-intent'
import {
  actionEditOrderColor,
  actionUpdateOrderItems,
  actionUpdatePendingQuotation,
  findRecentOrderForPhone,
  isAddToOrderRequest,
} from './order-edit-intent'
import { sendLocalTextQuickReply, sendQuickReplyByCatalogId } from './send-quick-reply'
import { IDENTIFY_CONFIDENCE_THRESHOLD } from './types'
import type { ReplyMode } from './language'
import type { ToolCallRequest } from './tools'

export type ToolExecContext = {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  contactPhone: string | null
  useSinglish: boolean
  replyMode: ReplyMode
  inboundImages: Array<{
    mediaUrl?: string | null
    metaMediaId?: string | null
    caption?: string | null
  }>
  burstText: string
  productCatalog: MatchableQuickReply[]
  customCatalog: CustomQuickReply[]
}

export type ToolExecResult = {
  replied: boolean
  handoff: boolean
  note: string
  /** Structured payload returned to the model for multi-round reasoning. */
  resultPayload?: unknown
}

/**
 * Execute one Sales Agent tool. Side effects (WhatsApp sends) happen here;
 * the LLM only decides which tool(s) to call.
 */
export async function executeAgentTool(
  ctx: ToolExecContext,
  call: ToolCallRequest,
): Promise<ToolExecResult> {
  const name = normalizeToolName(call.name)
  const a = call.arguments

  switch (name) {
    case 'identify_product':
      return execIdentifyProduct(ctx, a)
    case 'find_product':
      return execFindProduct(ctx, a)
    case 'generate_quote':
    case 'send_quotation':
      return execGenerateQuote(ctx, a)
    case 'create_order':
      return execCreateOrder(ctx, a)
    case 'update_order':
    case 'edit_order':
      return execUpdateOrder(ctx, a)
    case 'answer_delivery':
      return execAnswerCustomQr(ctx, a, 'delivery')
    case 'answer_policy':
      return execAnswerCustomQr(ctx, a, 'policy')
    case 'send_quick_reply':
      return execSendQuickReplyLegacy(ctx, a)
    case 'ask_missing_information':
      return execAskMissing(ctx, a)
    case 'confirm_order':
      return execConfirmOrder(ctx, a)
    case 'send_tracking':
      return execSendTracking(ctx)
    case 'handover_to_human':
    case 'mark_human':
      return execHandover(ctx, a)
    default:
      return {
        replied: false,
        handoff: false,
        note: `unknown tool ${call.name}`,
      }
  }
}

function normalizeToolName(name: string): string {
  const n = (name || '').trim()
  const aliases: Record<string, string> = {
    send_quotation: 'generate_quote',
    edit_order: 'update_order',
    mark_human: 'handover_to_human',
  }
  return aliases[n] || n
}

async function execIdentifyProduct(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const sendCard = a.send_product_card !== false
  const images = ctx.inboundImages.filter((i) => i.metaMediaId || i.mediaUrl)

  if (!images.length) {
    return {
      replied: false,
      handoff: false,
      note: 'no inbound images to identify',
      resultPayload: { matches: [], error: 'no_images' },
    }
  }

  // Pending low-confidence confirm in flight — resolve yes/no from burst text
  const { data: conv } = await ctx.db
    .from('conversations')
    .select('sa_identify_pending')
    .eq('id', ctx.conversationId)
    .maybeSingle()
  const pending = parseIdentifyPending(conv?.sa_identify_pending)
  if (pending && ctx.burstText.trim()) {
    const r = await resolveIdentifyConfirm({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      inboundText: ctx.burstText,
      pending,
      useSinglish: ctx.useSinglish,
    })
    if (r.handled) {
      return {
        replied: true,
        handoff: false,
        note: 'resolved identify confirmation',
        resultPayload: { confirmed: true, product: pending.product },
      }
    }
  }

  if (sendCard) {
    const r = await handleInboundIdentifyMany({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      images,
      burstText: ctx.burstText,
      useSinglish: ctx.useSinglish,
    })
    return {
      replied: r.handled,
      handoff: false,
      note: r.sentQr
        ? `identified + sent ${r.qrCount} product card(s)`
        : r.handled
          ? 'identified — asked customer to confirm'
          : 'identify produced no match',
      resultPayload: {
        identified: r.identified,
        sentQr: r.sentQr,
        qrCount: r.qrCount,
      },
    }
  }

  // Facts only — let the model call find_product / generate_quote next
  const matches: Array<{
    product: string
    color: string
    confidence: number
    catalog_message_id: string | null
    quick_reply_id: string | null
  }> = []

  for (const img of images) {
    try {
      const found = await identifyInboundImage({
        db: ctx.db,
        accountId: ctx.accountId,
        mediaUrl: img.mediaUrl,
        metaMediaId: img.metaMediaId,
      })
      const best = found[0]
      if (!best) continue
      const qr = matchProductByIdentifyName(best.product, ctx.productCatalog)
      matches.push({
        product: best.product,
        color: best.color,
        confidence: best.confidence,
        catalog_message_id: qr?.catalog_message_id ?? null,
        quick_reply_id: qr?.id ?? null,
      })
    } catch (err) {
      console.error('[sales-agent] identify_product failed:', err)
    }
  }

  return {
    replied: false,
    handoff: false,
    note: matches.length
      ? `found ${matches.length} match(es); send_product_card=false`
      : 'no matches',
    resultPayload: {
      matches,
      highConfidence: matches.filter(
        (m) => m.confidence >= IDENTIFY_CONFIDENCE_THRESHOLD,
      ),
    },
  }
}

async function execFindProduct(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const catalogMessageId =
    typeof a.catalog_message_id === 'string' ? a.catalog_message_id : ''
  const quickReplyId =
    typeof a.quick_reply_id === 'string' ? a.quick_reply_id : ''
  const productId = typeof a.product_id === 'string' ? a.product_id : ''
  const productName =
    typeof a.product_name === 'string' ? a.product_name.trim() : ''
  const color = typeof a.color === 'string' ? a.color.trim() : ''

  let hit: MatchableQuickReply | null = null

  if (catalogMessageId) {
    hit =
      ctx.productCatalog.find((p) => p.catalog_message_id === catalogMessageId) ??
      null
  }
  if (!hit && quickReplyId) {
    hit = ctx.productCatalog.find((p) => p.id === quickReplyId) ?? null
  }
  if (!hit && productId) {
    hit = ctx.productCatalog.find((p) => p.product_id === productId) ?? null
  }
  if (!hit && productName) {
    hit = matchProductByIdentifyName(productName, ctx.productCatalog)
    if (!hit) {
      const hits = matchProductsInText(productName, ctx.productCatalog)
      hit = hits[0] ?? null
    }
  }

  if (!hit?.catalog_message_id) {
    return {
      replied: false,
      handoff: false,
      note: `product not found: ${productName || productId || catalogMessageId || quickReplyId || '(empty)'}`,
      resultPayload: { found: false },
    }
  }

  const display = productDisplayName(hit.title)
  await sendQuickReplyByCatalogId({
    db: ctx.db,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    catalogMessageId: hit.catalog_message_id,
    contextSummary: `Sent product quick reply for ${display}${color ? ` (${color})` : ''}`,
  })

  // Remember bag (+ color) for later quote/order
  try {
    const intent: BagOrderIntent = {
      productId: hit.product_id,
      catalogMessageId: hit.catalog_message_id,
      name: display,
      color: color || null,
      qty: 1,
      quickReplyId: hit.id,
    }
    const items = await resolveLineItems([intent])
    if (items.length) {
      await upsertAwaitingAddressItems(
        ctx.db,
        ctx.conversationId,
        toPendingQuotedItems(items),
      )
    }
  } catch (err) {
    console.warn('[sales-agent] find_product memory save failed:', err)
  }

  return {
    replied: true,
    handoff: false,
    note: `sent product card: ${display}`,
    resultPayload: {
      found: true,
      title: display,
      product_id: hit.product_id,
      catalog_message_id: hit.catalog_message_id,
      color: color || null,
    },
  }
}

async function execGenerateQuote(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  let items = await resolveItemsArg(ctx, a.items)
  if (!items.length) {
    items = await loadPendingItems(ctx)
  }
  if (!items.length && ctx.burstText.trim()) {
    const intents = matchProductsInText(ctx.burstText, ctx.productCatalog).map(
      (hit) =>
        ({
          productId: hit.product_id,
          catalogMessageId: hit.catalog_message_id,
          name: productDisplayName(hit.title),
          color: null,
          qty: 1,
          quickReplyId: hit.id,
        }) satisfies BagOrderIntent,
    )
    items = await resolveLineItems(intents)
  }
  if (!items.length) {
    return {
      replied: false,
      handoff: false,
      note: 'no items for quotation — ask which bag',
      resultPayload: { ok: false, need: 'bag' },
    }
  }

  const r = await actionSendQuotation({
    db: ctx.db,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    configOwnerUserId: ctx.configOwnerUserId,
    items,
    useSinglish: ctx.useSinglish,
  })
  return {
    replied: r.ok,
    handoff: false,
    note: r.message,
    resultPayload: { ok: r.ok, items },
  }
}

async function execCreateOrder(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const addressText =
    typeof a.address_text === 'string' ? a.address_text.trim() : ''
  if (!addressText) {
    return {
      replied: false,
      handoff: false,
      note: 'missing address_text',
      resultPayload: { ok: false, need: 'address' },
    }
  }

  let items = await resolveItemsArg(ctx, a.items)
  if (!items.length) {
    items = await loadPendingItems(ctx)
  }
  if (!items.length) {
    return {
      replied: false,
      handoff: false,
      note: 'no bag/color for order — ask which bag and color',
      resultPayload: { ok: false, need: 'bag_or_color' },
    }
  }

  const missingColor = items.filter((i) => !String(i.color || '').trim())
  if (missingColor.length) {
    return {
      replied: false,
      handoff: false,
      note: 'bag known but color missing — ask color before create_order',
      resultPayload: {
        ok: false,
        need: 'color',
        bags: missingColor.map((i) => i.name),
      },
    }
  }

  const r = await actionCreateOrder({
    db: ctx.db,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    configOwnerUserId: ctx.configOwnerUserId,
    addressText,
    items,
    contactPhone: ctx.contactPhone,
    useSinglish: ctx.useSinglish,
  })

  if (r.ok) {
    await ctx.db
      .from('conversations')
      .update({ sa_order_pending: null })
      .eq('id', ctx.conversationId)
  }

  return {
    replied: r.ok,
    handoff: false,
    note: r.message,
    resultPayload: { ok: r.ok },
  }
}

async function execUpdateOrder(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const color =
    typeof a.color === 'string'
      ? a.color
      : typeof (a.patch as { color?: string } | undefined)?.color === 'string'
        ? (a.patch as { color: string }).color
        : null
  const targetName =
    typeof a.target_name === 'string' ? a.target_name : null

  const items = await resolveItemsArg(ctx, a.items)
  const explicitMode =
    a.mode === 'replace' || a.mode === 'add' ? (a.mode as 'add' | 'replace') : null
  const mode: 'add' | 'replace' =
    explicitMode ||
    (isAddToOrderRequest(ctx.burstText) ? 'add' : items.length ? 'add' : 'replace')

  const recent = await findRecentOrderForPhone(ctx.contactPhone)

  // No live order yet → update last quotation (or send a new one)
  if (!recent) {
    if (!items.length && !color) {
      return {
        replied: false,
        handoff: false,
        note: 'no order and no bag/color changes — ask what to change',
        resultPayload: { ok: false, need: 'bag_or_color', scope: 'quotation' },
      }
    }
    const r = await actionUpdatePendingQuotation({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      useSinglish: ctx.useSinglish,
      mode,
      items: items.length ? items : undefined,
      color,
      targetName,
    })
    return {
      replied: r.ok,
      handoff: false,
      note: r.message,
      resultPayload: {
        ok: r.ok,
        scope: 'quotation',
        mode,
        items: r.items,
      },
    }
  }

  // Color-only change (no new line items) — patch existing lines + confirm screenshot
  if (color && !items.length) {
    const r = await actionEditOrderColor({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      contactPhone: ctx.contactPhone!,
      newColor: color,
      useSinglish: ctx.useSinglish,
      targetName,
    })
    return {
      replied: r.ok,
      handoff: false,
      note: r.message,
      resultPayload: { ok: r.ok, mode: 'color', scope: 'order' },
    }
  }

  if (items.length) {
    const r = await actionUpdateOrderItems({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      configOwnerUserId: ctx.configOwnerUserId,
      contactPhone: ctx.contactPhone,
      orderId:
        (typeof a.order_id === 'string' ? a.order_id : null) || recent.id,
      items,
      mode,
    })
    return {
      replied: r.ok,
      handoff: false,
      note: r.message,
      resultPayload: { ok: r.ok, mode, items: r.items, scope: 'order' },
    }
  }

  // Advanced patch (address / notes / etc.) — still re-send confirm when possible
  let orderId =
    (typeof a.order_id === 'string' ? a.order_id : '') || recent.id
  const patch =
    a.patch && typeof a.patch === 'object'
      ? ({ ...(a.patch as Record<string, unknown>) } as Record<string, unknown>)
      : ({} as Record<string, unknown>)

  if (!Object.keys(patch).length) {
    return { replied: false, handoff: false, note: 'empty patch' }
  }

  const r = await actionEditOrder({ orderId, patch })
  if (r.ok && ctx.contactPhone) {
    try {
      const { fetchOrderByPhone } = await import(
        '@/lib/orders/ladiesbags-orders'
      )
      const fresh = (await fetchOrderByPhone({
        phone: ctx.contactPhone,
        days: 7,
        whatsappOnly: false,
      })) as { order?: Record<string, unknown> }
      if (fresh?.order) {
        const { sendOrderConfirmScreenshot } = await import(
          './order-screenshot'
        )
        const { addNamedTag } = await import('./tags')
        await sendOrderConfirmScreenshot({
          db: ctx.db,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          contactId: ctx.contactId,
          configOwnerUserId: ctx.configOwnerUserId,
          order: fresh.order,
        })
        await addNamedTag(ctx.db, ctx.accountId, ctx.contactId, 'Pending')
      }
    } catch (err) {
      console.warn('[sales-agent] post-patch confirm screenshot failed:', err)
    }
  }
  return {
    replied: r.ok,
    handoff: false,
    note: r.message,
    resultPayload: { ok: r.ok, scope: 'order' },
  }
}

async function execAnswerCustomQr(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
  mode: 'delivery' | 'policy',
): Promise<ToolExecResult> {
  const catalogMessageId =
    typeof a.catalog_message_id === 'string' ? a.catalog_message_id.trim() : ''
  const quickReplyId =
    typeof a.quick_reply_id === 'string' ? a.quick_reply_id.trim() : ''
  const reason =
    typeof a.reason === 'string' ? a.reason.trim().slice(0, 200) : ''

  const customs =
    ctx.customCatalog.length > 0
      ? ctx.customCatalog
      : await loadCustomQuickReplies(ctx.db, ctx.accountId)

  // LLM must pick from the FAQ list — no synonym/token fuzzy match.
  if (!quickReplyId && !catalogMessageId) {
    return {
      replied: false,
      handoff: false,
      note: `missing quick_reply_id — pick the best FAQ id from the list, or call handover_to_human if none fit`,
      resultPayload: {
        matched: false,
        need: 'quick_reply_id',
        available: customs.slice(0, 40).map((q) => ({
          id: q.id,
          title: q.title,
          description: (q.description || '').slice(0, 160),
          catalog_message_id: q.catalog_message_id,
        })),
      },
    }
  }

  const qr = findCustomQuickReply(customs, {
    quickReplyId,
    catalogMessageId,
  })

  if (!qr) {
    // Still try raw catalog / DB id send (legacy)
    if (catalogMessageId) {
      await sendQuickReplyByCatalogId({
        db: ctx.db,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        catalogMessageId,
        contextSummary: reason || `Sent ${mode} quick reply ${catalogMessageId}`,
      })
      return {
        replied: true,
        handoff: false,
        note: `sent catalog ${catalogMessageId}`,
      }
    }
    const sent = await sendQrById(ctx, quickReplyId)
    if (sent) return sent
    return {
      replied: false,
      handoff: false,
      note: `quick reply not found for id=${quickReplyId || catalogMessageId} — pick another id or handover_to_human`,
      resultPayload: {
        matched: false,
        available: customs.slice(0, 40).map((q) => ({
          id: q.id,
          title: q.title,
          description: (q.description || '').slice(0, 160),
        })),
      },
    }
  }

  const sent = await sendCustomQr(ctx, qr)
  return {
    ...sent,
    resultPayload: {
      matched: true,
      title: qr.title,
      id: qr.id,
      mode,
      reason: reason || undefined,
    },
  }
}

async function execSendQuickReplyLegacy(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const catalogId =
    typeof a.catalog_message_id === 'string' ? a.catalog_message_id : ''
  const qrId = typeof a.quick_reply_id === 'string' ? a.quick_reply_id : ''
  if (catalogId) {
    await sendQuickReplyByCatalogId({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      catalogMessageId: catalogId,
      contextSummary:
        typeof a.reason === 'string'
          ? `Sent quick reply: ${a.reason}`
          : `Sent catalog quick reply ${catalogId}`,
    })
    return { replied: true, handoff: false, note: `sent catalog ${catalogId}` }
  }
  if (qrId) {
    const sent = await sendQrById(ctx, qrId)
    if (sent) return sent
  }
  return { replied: false, handoff: false, note: 'quick reply not found' }
}

async function execAskMissing(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const message = typeof a.message === 'string' ? a.message.trim() : ''
  if (!message) {
    return { replied: false, handoff: false, note: 'empty ask message' }
  }
  await engineSendText({
    accountId: ctx.accountId,
    userId: ctx.configOwnerUserId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    text: message.slice(0, 1500),
    aiGenerated: true,
  })
  return {
    replied: true,
    handoff: false,
    note: `asked: ${message.slice(0, 80)}`,
  }
}

async function execConfirmOrder(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  const text =
    (typeof a.customer_text === 'string' && a.customer_text.trim()) ||
    ctx.burstText
  if (!text.trim()) {
    return { replied: false, handoff: false, note: 'no confirmation text' }
  }
  const ok = await maybeConfirmOrderTag({
    db: ctx.db,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    configOwnerUserId: ctx.configOwnerUserId,
    inboundText: text,
    useSinglish: ctx.useSinglish,
    replyMode: ctx.replyMode,
  })
  return {
    replied: ok,
    handoff: false,
    note: ok ? 'Pending → Confirmed' : 'not a pending-order confirm',
    resultPayload: { confirmed: ok },
  }
}

async function execSendTracking(ctx: ToolExecContext): Promise<ToolExecResult> {
  if (!ctx.contactPhone) {
    return { replied: false, handoff: false, note: 'no contact phone' }
  }
  const r = await actionSendTracking({
    db: ctx.db,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    configOwnerUserId: ctx.configOwnerUserId,
    contactPhone: ctx.contactPhone,
  })
  return { replied: r.ok, handoff: false, note: r.message }
}

async function execHandover(
  ctx: ToolExecContext,
  a: Record<string, unknown>,
): Promise<ToolExecResult> {
  await actionMarkHuman({
    db: ctx.db,
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    reason: typeof a.reason === 'string' ? a.reason : undefined,
  })
  return { replied: false, handoff: true, note: 'marked Human' }
}

async function sendQrById(
  ctx: ToolExecContext,
  qrId: string,
): Promise<ToolExecResult | null> {
  const { data: qr } = await ctx.db
    .from('quick_replies')
    .select('*')
    .eq('id', qrId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!qr) return null
  if (qr.catalog_message_id) {
    await sendQuickReplyByCatalogId({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      catalogMessageId: qr.catalog_message_id,
      contextSummary: qr.description || qr.title,
    })
    return { replied: true, handoff: false, note: `sent QR ${qr.title}` }
  }
  if (qr.kind === 'text' && qr.content_text) {
    await sendLocalTextQuickReply({
      db: ctx.db,
      accountId: ctx.accountId,
      userId: ctx.configOwnerUserId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      text: qr.content_text,
      contextSummary: qr.description || qr.title,
    })
    return { replied: true, handoff: false, note: `sent text QR ${qr.title}` }
  }
  return null
}

async function sendCustomQr(
  ctx: ToolExecContext,
  qr: CustomQuickReply,
): Promise<ToolExecResult> {
  if (qr.catalog_message_id) {
    await sendQuickReplyByCatalogId({
      db: ctx.db,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      catalogMessageId: qr.catalog_message_id,
      contextSummary: qr.description || `Sent custom QR: ${qr.title}`,
    })
    return { replied: true, handoff: false, note: `sent custom QR: ${qr.title}` }
  }
  if (qr.kind === 'text' && qr.content_text) {
    await sendLocalTextQuickReply({
      db: ctx.db,
      accountId: ctx.accountId,
      userId: ctx.configOwnerUserId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      text: qr.content_text,
      contextSummary: qr.description || `Sent quick reply: ${qr.title}`,
    })
    return { replied: true, handoff: false, note: `sent text QR: ${qr.title}` }
  }
  return {
    replied: false,
    handoff: false,
    note: `QR "${qr.title}" has no sendable content`,
  }
}

async function resolveItemsArg(
  ctx: ToolExecContext,
  raw: unknown,
): Promise<OrderLineItem[]> {
  const normalized = normalizeItems(raw)
  if (!normalized.length) return []

  const intents: BagOrderIntent[] = normalized.map((it) => {
    const hit =
      (it.productId &&
        ctx.productCatalog.find((p) => p.product_id === it.productId)) ||
      matchProductByIdentifyName(it.name, ctx.productCatalog) ||
      matchProductsInText(it.name, ctx.productCatalog)[0] ||
      null
    return {
      productId: it.productId || hit?.product_id || null,
      catalogMessageId: hit?.catalog_message_id || null,
      name: it.name || (hit ? productDisplayName(hit.title) : ''),
      color: it.color || null,
      qty: it.qty,
      quickReplyId: hit?.id || '',
    }
  })

  return resolveLineItems(intents.filter((i) => i.name))
}

async function loadPendingItems(
  ctx: ToolExecContext,
): Promise<OrderLineItem[]> {
  const { data: conv } = await ctx.db
    .from('conversations')
    .select('sa_order_pending')
    .eq('id', ctx.conversationId)
    .maybeSingle()
  const pending = parseOrderPending(conv?.sa_order_pending)
  if (!pending) return []

  const quoted: OrderPendingQuotedItem[] =
    pending.type === 'awaiting_address'
      ? pending.items || []
      : pending.type === 'awaiting_color'
        ? [
            ...(pending.readyItems || []),
            ...((pending.bags || []).map((b) => ({
              productId: b.productId,
              name: b.name,
              color: '',
              qty: b.qty,
              price: 0,
            })) as OrderPendingQuotedItem[]),
          ]
        : []

  if (!quoted.length) return []

  return resolveLineItems(
    quoted.map(
      (q) =>
        ({
          productId: q.productId ?? null,
          catalogMessageId: null,
          name: q.name,
          color: q.color || null,
          qty: q.qty || 1,
          quickReplyId: '',
        }) satisfies BagOrderIntent,
    ),
  )
}

function normalizeItems(raw: unknown): OrderLineItem[] {
  if (!Array.isArray(raw)) return []
  const out: OrderLineItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : ''
    if (!name) continue
    const qty = Math.max(1, Number(o.qty ?? o.quantity) || 1)
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

/** Prefetch catalogs once per dispatch for tool execution + prompt listing. */
export async function loadAgentCatalogs(
  db: SupabaseClient,
  accountId: string,
): Promise<{
  products: MatchableQuickReply[]
  customs: CustomQuickReply[]
}> {
  const [products, customs] = await Promise.all([
    loadProductQuickReplies(db, accountId),
    loadCustomQuickReplies(db, accountId),
  ])
  return { products, customs }
}
