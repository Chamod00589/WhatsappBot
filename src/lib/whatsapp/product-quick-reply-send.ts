/**
 * Send a catalog quick-reply (product or custom from ladiesbags admin).
 *
 * Prefer Meta `link` send when images are JPEG/PNG (from Prepare JPEGs).
 * Fall back to download→convert→upload only for leftover WebP URLs.
 * CRM chat stores ONLY the short stub title.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { prepareCatalogImageForWhatsApp } from '@/lib/catalog/prepare-image'
import {
  fetchCatalogQuickMessage,
  isMetaFriendlyImageUrl,
  stubTitleForCatalogMessage,
  type CatalogQuickMessage,
} from '@/lib/catalog/products'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import {
  sendMediaMessage,
  sendTextMessage,
  uploadWhatsAppMedia,
} from '@/lib/whatsapp/meta-api'
import {
  isRecipientNotAllowedError,
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export interface ProductQuickReplySendResult {
  ok: boolean
  stubMessageId: string
  productId: string | null
  productName: string
  shortTitle: string
  imagesAttempted: number
  imagesSent: number
  textSent: boolean
  usedDirectLinks: number
  usedUploadConvert: number
  failures: string[]
}

async function loadSendContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
) {
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single()

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404)
  }

  const contact = conversation.contact
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400,
    )
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400,
    )
  }

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()

  if (configError || !config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400,
    )
  }

  const accessToken = decrypt(config.access_token)
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
  }

  return {
    contactId: contact.id as string,
    sanitizedPhone,
    phoneNumberId: config.phone_number_id as string,
    accessToken,
  }
}

async function withPhoneRetry<T>(
  sanitizedPhone: string,
  contactId: string,
  db: SupabaseClient,
  attempt: (phone: string) => Promise<T>,
): Promise<T> {
  const variants = phoneVariants(sanitizedPhone)
  let lastError: unknown = null
  let workingPhone = sanitizedPhone

  for (const variant of variants) {
    try {
      const result = await attempt(variant)
      workingPhone = variant
      lastError = null
      if (workingPhone !== sanitizedPhone) {
        await db.from('contacts').update({ phone: workingPhone }).eq('id', contactId)
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(message)) throw err
      lastError = err
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('All phone variants rejected')
}

export async function sendCatalogQuickReply(
  db: SupabaseClient,
  accountId: string,
  args: {
    conversationId: string
    catalogMessageId: string
    stubTitle?: string | null
  },
): Promise<ProductQuickReplySendResult> {
  const { conversationId, catalogMessageId, stubTitle } = args

  const msg = await fetchCatalogQuickMessage(catalogMessageId)
  if (!msg) {
    throw new SendMessageError(
      'not_found',
      `Quick message "${catalogMessageId}" not found in catalog`,
      404,
    )
  }

  return deliverCatalogMessage(db, accountId, conversationId, msg, stubTitle)
}

/** @deprecated Prefer sendCatalogQuickReply */
export async function sendProductQuickReply(
  db: SupabaseClient,
  accountId: string,
  args: {
    conversationId: string
    productId: string
    stubTitle?: string | null
  },
): Promise<ProductQuickReplySendResult> {
  const messages = await (
    await import('@/lib/catalog/products')
  ).fetchCatalogQuickMessages()
  const msg = messages.find((m) => m.productId === args.productId)
  if (!msg) {
    throw new SendMessageError(
      'not_found',
      `Product "${args.productId}" not found in quick messages`,
      404,
    )
  }
  return deliverCatalogMessage(
    db,
    accountId,
    args.conversationId,
    msg,
    args.stubTitle,
  )
}

async function deliverCatalogMessage(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  msg: CatalogQuickMessage,
  stubTitle?: string | null,
): Promise<ProductQuickReplySendResult> {
  const imageUrls = [...(msg.imageUrls || [])]
  const captionRaw = msg.text || msg.title
  const caption = captionRaw.length > 1024 ? captionRaw.slice(0, 1024) : captionRaw
  const shortTitle =
    (stubTitle && stubTitle.trim()) || stubTitleForCatalogMessage(msg)

  const ctx = await loadSendContext(db, accountId, conversationId)
  const failures: string[] = []
  let imagesSent = 0
  let textSent = false
  let usedDirectLinks = 0
  let usedUploadConvert = 0
  let lastWamid: string | null = null
  let lastPersistedId: string | null = null

  const persistOutbound = async (row: {
    contentType: 'image' | 'text'
    contentText: string | null
    mediaUrl: string | null
    messageId: string
  }) => {
    const { data, error } = await db
      .from('messages')
      .insert({
        conversation_id: conversationId,
        sender_type: 'agent',
        content_type: row.contentType,
        // CRM shows short title (not the long WhatsApp caption) so the
        // thread stays light — media_url still holds the JPEG for quotes.
        content_text: row.contentText,
        media_url: row.mediaUrl,
        message_id: row.messageId,
        status: 'sent',
      })
      .select('id')
      .single()
    if (error || !data) {
      throw new SendMessageError(
        'db_error',
        `Sent to WhatsApp but failed to save message: ${error?.message ?? 'unknown'}`,
        500,
      )
    }
    lastPersistedId = data.id as string
  }

  // Send images one-by-one; never start the next until Meta ack + persist done.
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i]
    // Full Sinhala caption goes to the customer on the first image only.
    const imageCaption = i === 0 ? caption : undefined
    try {
      if (msg.jpegReady || isMetaFriendlyImageUrl(url)) {
        lastWamid = await withPhoneRetry(
          ctx.sanitizedPhone,
          ctx.contactId,
          db,
          async (phone) => {
            const result = await sendMediaMessage({
              phoneNumberId: ctx.phoneNumberId,
              accessToken: ctx.accessToken,
              to: phone,
              kind: 'image',
              link: url,
              caption: imageCaption,
            })
            return result.messageId
          },
        )
        usedDirectLinks += 1
      } else {
        const prepared = await prepareCatalogImageForWhatsApp(url)
        const uploaded = await uploadWhatsAppMedia({
          phoneNumberId: ctx.phoneNumberId,
          accessToken: ctx.accessToken,
          bytes: prepared.bytes,
          mimeType: prepared.mimeType,
          filename: prepared.filename,
        })
        lastWamid = await withPhoneRetry(
          ctx.sanitizedPhone,
          ctx.contactId,
          db,
          async (phone) => {
            const result = await sendMediaMessage({
              phoneNumberId: ctx.phoneNumberId,
              accessToken: ctx.accessToken,
              to: phone,
              kind: 'image',
              id: uploaded.id,
              caption: imageCaption,
            })
            return result.messageId
          },
        )
        usedUploadConvert += 1
      }

      // Persist each image with its Meta wamid + public URL so inbound
      // swipe-replies can resolve and show the quoted thumbnail.
      await persistOutbound({
        contentType: 'image',
        contentText: i === 0 ? shortTitle : null,
        mediaUrl: url,
        messageId: lastWamid,
      })
      imagesSent += 1

      // Gap between images in the same QR (and before leaving this QR).
      if (i < imageUrls.length - 1) {
        await new Promise((r) => setTimeout(r, 600))
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      failures.push(`Image ${i + 1}: ${errMsg}`)
      console.error('[catalog-quick-reply] image send failed:', url, errMsg)
    }
  }

  if (imagesSent === 0 && caption.trim()) {
    try {
      lastWamid = await withPhoneRetry(
        ctx.sanitizedPhone,
        ctx.contactId,
        db,
        async (phone) => {
          const result = await sendTextMessage({
            phoneNumberId: ctx.phoneNumberId,
            accessToken: ctx.accessToken,
            to: phone,
            text: caption,
          })
          return result.messageId
        },
      )
      await persistOutbound({
        contentType: 'text',
        contentText: shortTitle,
        mediaUrl: null,
        messageId: lastWamid,
      })
      textSent = true
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      failures.push(`Caption text: ${errMsg}`)
      throw new SendMessageError(
        'meta_error',
        `Could not send quick message: ${errMsg}`,
        502,
      )
    }
  }

  if (!lastPersistedId) {
    throw new SendMessageError(
      'meta_error',
      'No product images or text could be sent',
      502,
    )
  }

  await db
    .from('conversations')
    .update({
      last_message_text: shortTitle,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  try {
    await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
      })
      .eq('contact_id', ctx.contactId)
      .eq('status', 'active')
  } catch {
    // best-effort
  }

  return {
    ok: imagesSent > 0 || textSent,
    stubMessageId: lastPersistedId,
    productId: msg.productId,
    productName: msg.title,
    shortTitle,
    imagesAttempted: imageUrls.length,
    imagesSent,
    textSent,
    usedDirectLinks,
    usedUploadConvert,
    failures,
  }
}
