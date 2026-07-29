import type { SupabaseClient } from '@supabase/supabase-js'
import { identifyBag, type BagMatch } from '@/lib/bagIdentify'
import { fetchCatalogQuickMessage } from '@/lib/catalog/products'
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
} from './match-products'
import { sendQuickReplyByCatalogId } from './send-quick-reply'
import { identifyRejectText, identifyConfirmAskText } from './identify-text'

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
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    mediaUrl,
    metaMediaId,
    useSinglish,
  } = args

  let matches: BagMatch[]
  try {
    matches = await identifyInboundImage({
      db,
      accountId,
      mediaUrl,
      metaMediaId,
    })
  } catch (err) {
    console.error('[sales-agent] identify failed:', err)
    return { handled: false, sentQr: false }
  }

  const best = matches[0]
  if (!best) return { handled: false, sentQr: false }

  const catalog = await loadProductQuickReplies(db, accountId)
  const qr = matchProductByIdentifyName(best.product, catalog)

  if (best.confidence >= IDENTIFY_CONFIDENCE_THRESHOLD && qr?.catalog_message_id) {
    await sendQuickReplyByCatalogId({
      db,
      accountId,
      conversationId,
      catalogMessageId: qr.catalog_message_id,
      contextSummary: `Sent product quick reply for ${best.product} (${best.color}) after image identify ${best.confidence.toFixed(0)}%`,
    })
    await clearIdentifyPending(db, conversationId)
    return { handled: true, sentQr: true }
  }

  const pending: IdentifyPendingState = {
    product: best.product,
    color: best.color,
    confidence: best.confidence,
    catalogMessageId: qr?.catalog_message_id ?? null,
    quickReplyId: qr?.id ?? null,
    askedAt: new Date().toISOString(),
  }
  await db
    .from('conversations')
    .update({ sa_identify_pending: pending })
    .eq('id', conversationId)

  const ask = identifyConfirmAskText(
    best.product,
    best.color,
    best.confidence,
    useSinglish,
  )

  // Send only the top matching product image + ask (not full QR yet)
  let imageSent = false
  if (qr?.catalog_message_id) {
    try {
      const msg = await fetchCatalogQuickMessage(qr.catalog_message_id)
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

  return { handled: true, sentQr: false }
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
  return { handled: true }
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
