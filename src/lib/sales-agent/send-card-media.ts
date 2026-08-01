import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import { uploadWhatsAppMedia } from '@/lib/whatsapp/meta-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export type CardMediaDebug = {
  bytes: number
  storagePath: string
  publicUrl: string
  metaMediaId: string | null
  sendMode: 'meta_id' | 'link'
  messageId: string | null
  whatsappMessageId: string
}

/**
 * Upload a generated card image to chat-media (inbox preview) and send
 * via Meta media id (reliable). Falls back to public link if Meta upload fails.
 */
export async function sendGeneratedCardImage(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** JPEG or PNG bytes */
  bytes: Buffer
  /** e.g. order-123.jpg */
  filename: string
  mimeType?: 'image/jpeg' | 'image/png'
  caption?: string
  contextSummary: string
}): Promise<CardMediaDebug> {
  const {
    db,
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    bytes,
    filename,
    caption,
    contextSummary,
  } = args
  const mimeType = args.mimeType ?? 'image/jpeg'

  if (!bytes?.byteLength || bytes.byteLength < 200) {
    throw new Error(
      `Card image too small/empty (${bytes?.byteLength ?? 0} bytes)`,
    )
  }

  const path = buildMediaPath(accountId, filename)
  const { error: uploadErr } = await db.storage
    .from('chat-media')
    .upload(path, bytes, {
      cacheControl: '3600',
      upsert: false,
      contentType: mimeType,
    })
  if (uploadErr) {
    throw new Error(`chat-media upload failed: ${uploadErr.message}`)
  }

  const {
    data: { publicUrl },
  } = db.storage.from('chat-media').getPublicUrl(path)

  if (!publicUrl || !/^https?:\/\//i.test(publicUrl)) {
    throw new Error(`Invalid public URL after upload: ${publicUrl}`)
  }

  // Upload to Meta so WhatsApp does not need to fetch our storage URL
  // (that path often ends as status=failed + empty bubble).
  let metaMediaId: string | null = null
  try {
    const admin = supabaseAdmin()
    const { data: config, error: configErr } = await admin
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', accountId)
      .single()
    if (configErr || !config) {
      throw new Error('WhatsApp not configured')
    }
    const uploaded = await uploadWhatsAppMedia({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      bytes: new Uint8Array(bytes),
      mimeType,
      filename,
    })
    metaMediaId = uploaded.id
  } catch (err) {
    console.warn(
      '[sales-agent] Meta media upload failed — falling back to link:',
      err,
    )
  }

  const sent = await engineSendMedia({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    kind: 'image',
    link: publicUrl,
    mediaId: metaMediaId || undefined,
    caption: caption?.slice(0, 1024),
    aiGenerated: true,
  })

  if (sent.message_id) {
    await db
      .from('messages')
      .update({
        ai_context_summary: contextSummary,
        media_url: publicUrl,
        status: 'sent',
      })
      .eq('id', sent.message_id)
  }

  return {
    bytes: bytes.byteLength,
    storagePath: path,
    publicUrl,
    metaMediaId,
    sendMode: metaMediaId ? 'meta_id' : 'link',
    messageId: sent.message_id,
    whatsappMessageId: sent.whatsapp_message_id,
  }
}
