import type { SupabaseClient } from '@supabase/supabase-js'
import { identifyBag, type BagMatch } from '@/lib/bagIdentify'
import {
  fetchCatalogProduct,
  fetchCatalogQuickMessage,
} from '@/lib/catalog/products'
import { catalogImageForColor } from '@/lib/orders/catalog-helpers'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { engineSendText } from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import {
  IDENTIFY_CONFIDENCE_THRESHOLD,
  type IdentifyPendingState,
  CONTEXT_BLURBS,
} from './types'
import {
  loadProductQuickReplies,
  matchProductByIdentifyName,
  type MatchableQuickReply,
} from './match-products'
import { sendQuickReplyByCatalogId } from './send-quick-reply'
import { identifyRejectText, identifyConfirmAskText } from './identify-text'
import type { OrderPendingQuotedItem } from './order-intent'
import {
  assignQtysToImageLines,
  extractColorsFromText,
  upsertAwaitingAddressItems,
} from './order-intent'

export { identifyRejectText } from './identify-text'

/** Download inbound WhatsApp image bytes (Meta media id preferred). */
export async function loadInboundImageBytes(args: {
  db: SupabaseClient
  accountId: string
  metaMediaId?: string | null
  mediaUrl?: string | null
}): Promise<Buffer> {
  const mediaId =
    args.metaMediaId ||
    (args.mediaUrl?.match(/\/api\/whatsapp\/media\/([^/?#]+)/)?.[1] ?? null)

  if (mediaId) {
    const { data: config } = await args.db
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (!config?.access_token) {
      throw new Error('WhatsApp not configured for media download')
    }
    const accessToken = decrypt(config.access_token)
    const info = await getMediaUrl({ mediaId, accessToken })
    const { buffer } = await downloadMedia({
      downloadUrl: info.url,
      accessToken,
    })
    return Buffer.from(buffer)
  }

  if (args.mediaUrl && /^https?:\/\//i.test(args.mediaUrl)) {
    const res = await fetch(args.mediaUrl, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Failed to download media: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  throw new Error('No downloadable inbound image')
}

export async function identifyInboundImage(args: {
  db: SupabaseClient
  accountId: string
  metaMediaId?: string | null
  mediaUrl?: string | null
}): Promise<BagMatch[]> {
  const bytes = await loadInboundImageBytes(args)
  const result = await identifyBag(bytes, 'inbound.jpg')
  return result.matches ?? []
}


export function parseIdentifyPending(
  raw: unknown,
): IdentifyPendingState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.product !== 'string' || typeof o.color !== 'string') return null
  return {
    product: o.product,
    color: o.color,
    confidence: Number(o.confidence) || 0,
    catalogMessageId:
      typeof o.catalogMessageId === 'string' ? o.catalogMessageId : null,
    quickReplyId: typeof o.quickReplyId === 'string' ? o.quickReplyId : null,
    askedAt: typeof o.askedAt === 'string' ? o.askedAt : new Date().toISOString(),
  }
}

export function looksLikeConfirmYes(text: string): boolean {
  const t = text.toLowerCase().trim()
  return (
    /^(ok|okay|yes|y|yeah|yep|hari|hariy|correct|ow)\b/i.test(t) ||
    /that'?s?\s+(it|the\s+one)/i.test(t) ||
    /^(eka\s+)?thama\b/i.test(t) ||
    /^(ok|yes|hari)\s*[!.]*$/i.test(t)
  )
}

export function looksLikeConfirmNo(text: string): boolean {
  const t = text.toLowerCase().trim()
  return /^(no|nope|wrong|naha|n\b|nah)\b/i.test(t)
}

/**
 * Run identify on an inbound image and either send the product QR (≥90%)
 * or ask the customer to confirm the top match (single image + name).
 */
export async function handleInboundIdentify(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  mediaUrl?: string | null
  metaMediaId?: string | null
  useSinglish: boolean
}): Promise<{ handled: boolean; sentQr: boolean }> {
  const r = await handleInboundIdentifyMany({
    ...args,
    images: [{ mediaUrl: args.mediaUrl, metaMediaId: args.metaMediaId }],
  })
  return { handled: r.handled, sentQr: r.sentQr }
}

/**
 * Identify every image in a burst and send product QRs for each distinct
 * high-confidence match (serialized via QR send queue).
 */
export async function handleInboundIdentifyMany(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  images: Array<{
    mediaUrl?: string | null
    metaMediaId?: string | null
    caption?: string | null
  }>
  /** Full burst text (for zipping Nk qtys onto images). */
  burstText?: string
  useSinglish: boolean
}): Promise<{
  handled: boolean
  sentQr: boolean
  qrCount: number
  identified: Array<{ product: string; color: string; confidence: number }>
}> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    burstText = '',
    useSinglish,
  } = args

  const images = args.images.filter((i) => i.metaMediaId || i.mediaUrl)
  if (!images.length) {
    return { handled: false, sentQr: false, qrCount: 0, identified: [] }
  }

  const catalog = await loadProductQuickReplies(db, accountId)
  const identified: Array<{
    product: string
    color: string
    confidence: number
  }> = []
  const quotedItems: OrderPendingQuotedItem[] = []
  const imageCaptions: string[] = []
  const sentCatalogIds = new Set<string>()
  let qrCount = 0
  const needsConfirm: Array<{
    product: string
    color: string
    confidence: number
    catalogMessageId: string | null
    quickReplyId: string | null
  }> = []

  for (const img of images) {
    let matches: BagMatch[]
    try {
      matches = await identifyInboundImage({
        db,
        accountId,
        mediaUrl: img.mediaUrl,
        metaMediaId: img.metaMediaId,
      })
    } catch (err) {
      console.error('[sales-agent] identify failed for one image:', err)
      continue
    }

    const best = matches[0]
    if (!best) continue

    const caption = (img.caption || '').trim()
    let color = best.color
    if (caption) {
      const cols = extractColorsFromText(caption)
      if (cols.length) color = cols[0]
    }

    identified.push({
      product: best.product,
      color,
      confidence: best.confidence,
    })

    const qr = matchProductByIdentifyName(best.product, catalog)

    if (
      best.confidence >= IDENTIFY_CONFIDENCE_THRESHOLD &&
      qr?.catalog_message_id
    ) {
      if (sentCatalogIds.has(qr.catalog_message_id)) continue
      sentCatalogIds.add(qr.catalog_message_id)
      try {
        await sendQuickReplyByCatalogId({
          db,
          accountId,
          conversationId,
          catalogMessageId: qr.catalog_message_id,
          contextSummary: `Sent product quick reply for ${best.product} (${color}) after image identify ${best.confidence.toFixed(0)}%`,
        })
        qrCount += 1
        const line = await buildQuotedItemFromIdentify(
          { ...best, color },
          qr,
          caption,
        )
        if (line) {
          quotedItems.push(line)
          imageCaptions.push(caption)
        }
      } catch (err) {
        console.error('[sales-agent] identify QR send failed:', err)
      }
      continue
    }

    needsConfirm.push({
      product: best.product,
      color,
      confidence: best.confidence,
      catalogMessageId: qr?.catalog_message_id ?? null,
      quickReplyId: qr?.id ?? null,
    })
  }

  if (qrCount > 0) {
    await clearIdentifyPending(db, conversationId)
    if (quotedItems.length) {
      const qtys = assignQtysToImageLines(
        quotedItems.length,
        imageCaptions,
        burstText || imageCaptions.join('\n'),
      )
      for (let i = 0; i < quotedItems.length; i++) {
        quotedItems[i].qty = qtys[i] ?? quotedItems[i].qty ?? 1
      }
      await upsertAwaitingAddressItems(db, conversationId, quotedItems)
    }
    return { handled: true, sentQr: true, qrCount, identified }
  }

  // No high-confidence QR — ask confirm for the strongest single match
  // (same UX as single-image identify when multi-image also failed threshold).
  const bestLow = needsConfirm.sort((a, b) => b.confidence - a.confidence)[0]
  if (!bestLow && !identified.length) {
    return { handled: false, sentQr: false, qrCount: 0, identified }
  }
  if (!bestLow) {
    return { handled: false, sentQr: false, qrCount: 0, identified }
  }

  const pending: IdentifyPendingState = {
    product: bestLow.product,
    color: bestLow.color,
    confidence: bestLow.confidence,
    catalogMessageId: bestLow.catalogMessageId,
    quickReplyId: bestLow.quickReplyId,
    askedAt: new Date().toISOString(),
  }
  await db
    .from('conversations')
    .update({ sa_identify_pending: pending })
    .eq('id', conversationId)

  const ask = identifyConfirmAskText(
    bestLow.product,
    bestLow.color,
    bestLow.confidence,
    useSinglish,
  )

  let imageSent = false
  if (bestLow.catalogMessageId) {
    try {
      const msg = await fetchCatalogQuickMessage(bestLow.catalogMessageId)
      const imageUrl = msg?.imageUrls?.[0]
      if (imageUrl) {
        await engineSendMedia({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          kind: 'image',
          link: imageUrl,
          caption: ask.slice(0, 1024),
          aiGenerated: true,
        })
        imageSent = true
        await stampLatestOutboundSummary(
          db,
          conversationId,
          CONTEXT_BLURBS.identifyConfirm,
        )
      }
    } catch (err) {
      console.warn('[sales-agent] confirm image send failed:', err)
    }
  }

  if (!imageSent) {
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: ask,
      aiGenerated: true,
    })
    await stampLatestOutboundSummary(
      db,
      conversationId,
      CONTEXT_BLURBS.identifyConfirm,
    )
  }

  return { handled: true, sentQr: false, qrCount: 0, identified }
}

export async function resolveIdentifyConfirm(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  inboundText: string
  pending: IdentifyPendingState
  useSinglish: boolean
}): Promise<{ handled: boolean }> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundText,
    pending,
    useSinglish,
  } = args

  if (looksLikeConfirmNo(inboundText)) {
    await clearIdentifyPending(db, conversationId)
    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text: identifyRejectText(useSinglish),
      aiGenerated: true,
    })
    return { handled: true }
  }

  if (!looksLikeConfirmYes(inboundText)) {
    return { handled: false }
  }

  await clearIdentifyPending(db, conversationId)

  let catalogMessageId = pending.catalogMessageId
  if (!catalogMessageId) {
    const catalog = await loadProductQuickReplies(db, accountId)
    const qr = matchProductByIdentifyName(pending.product, catalog)
    catalogMessageId = qr?.catalog_message_id ?? null
  }

  if (catalogMessageId) {
    await sendQuickReplyByCatalogId({
      db,
      accountId,
      conversationId,
      catalogMessageId,
      contextSummary: `Confirmed identify: ${pending.product} / ${pending.color}`,
    })
  }

  const catalog = await loadProductQuickReplies(db, accountId)
  const qr = matchProductByIdentifyName(pending.product, catalog)
  if (qr) {
    const line = await buildQuotedItemFromIdentify(
      {
        product: pending.product,
        color: pending.color,
        confidence: pending.confidence,
      },
      qr,
    )
    if (line) {
      await upsertAwaitingAddressItems(db, conversationId, [line])
    }
  }
  return { handled: true }
}

async function buildQuotedItemFromIdentify(
  best: { product: string; color: string; confidence?: number },
  qr: MatchableQuickReply,
  caption?: string,
): Promise<OrderPendingQuotedItem | null> {
  const productId = qr.product_id || undefined
  let name = best.product
  let price = 0
  let color = best.color || ''
  let image: string | undefined
  if (caption) {
    const cols = extractColorsFromText(caption)
    if (cols.length) color = cols[0]
  }
  if (productId) {
    try {
      const p = await fetchCatalogProduct(productId)
      if (p) {
        name = p.name || name
        price = p.price || 0
        image = catalogImageForColor(p, color || p.colors[0] || '')
      }
    } catch {
      /* keep identify name */
    }
  }
  return {
    productId,
    name,
    color: color || '',
    qty: 1,
    price,
    image,
  }
}

async function clearIdentifyPending(
  db: SupabaseClient,
  conversationId: string,
): Promise<void> {
  await db
    .from('conversations')
    .update({ sa_identify_pending: null })
    .eq('id', conversationId)
}

async function stampLatestOutboundSummary(
  db: SupabaseClient,
  conversationId: string,
  summary: string,
): Promise<void> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (data?.id) {
    await db
      .from('messages')
      .update({ ai_context_summary: summary })
      .eq('id', data.id)
  }
}
