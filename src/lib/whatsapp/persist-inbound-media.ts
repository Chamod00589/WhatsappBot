import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

export const CHAT_MEDIA_BUCKET = 'chat-media'

/** Relative proxy path stored historically before inbound persistence. */
export function proxyMediaUrl(mediaId: string): string {
  return `/api/whatsapp/media/${mediaId}`
}

/**
 * Deterministic Storage object key so we can detect a prior cache hit
 * without a DB round-trip. Lives under the account folder so chat-media
 * RLS / path conventions still match.
 */
export function inboundMediaStoragePath(
  accountId: string,
  mediaId: string,
): string {
  const safeId = mediaId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
  return `account-${accountId}/wa-inbound/${safeId}`
}

export function normalizeMimeType(mime: string | null | undefined): string {
  const base = (mime ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
  if (!base) return 'application/octet-stream'
  // WhatsApp voice notes often arrive as audio/ogg; codecs=opus
  if (base === 'audio/ogg' || base.startsWith('audio/ogg')) return 'audio/ogg'
  return base
}

/** Map uncommon inbound MIMEs onto the chat-media allow-list. */
export function storageSafeMimeType(mime: string | null | undefined): string {
  const m = normalizeMimeType(mime)
  const allowed = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'video/mp4',
    'video/3gpp',
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr',
  ])
  if (allowed.has(m)) return m
  if (m.startsWith('image/')) return 'image/jpeg'
  if (m.startsWith('video/')) return 'video/mp4'
  if (m.startsWith('audio/')) return 'audio/ogg'
  return 'application/pdf'
}

const inflight = new Map<string, Promise<string>>()

export interface PersistInboundMediaArgs {
  db: SupabaseClient
  accountId: string
  mediaId: string
  accessToken: string
  mimeType?: string | null
  /** When set, rewrite messages still pointing at the proxy path. */
  rewriteMessageUrls?: boolean
}

/**
 * Download Meta media once, store in public `chat-media`, return the
 * durable public URL. Concurrent callers for the same mediaId share one
 * in-flight promise (avoids duplicate Meta + Storage work).
 */
export async function persistInboundWhatsAppMedia(
  args: PersistInboundMediaArgs,
): Promise<string> {
  const { db, accountId, mediaId, accessToken } = args
  const key = `${accountId}:${mediaId}`
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = persistInboundWhatsAppMediaOnce(args).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

async function persistInboundWhatsAppMediaOnce(
  args: PersistInboundMediaArgs,
): Promise<string> {
  const {
    db,
    accountId,
    mediaId,
    accessToken,
    mimeType,
    rewriteMessageUrls = true,
  } = args

  const path = inboundMediaStoragePath(accountId, mediaId)
  const {
    data: { publicUrl: cachedUrl },
  } = db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path)

  // Cheap existence check — no Meta call.
  if (cachedUrl && (await isPublicObjectPresent(cachedUrl))) {
    if (rewriteMessageUrls) {
      await rewriteProxyUrls(db, mediaId, cachedUrl)
    }
    return cachedUrl
  }

  const mediaInfo = await getMediaUrl({ mediaId, accessToken })
  const { buffer, contentType } = await downloadMedia({
    downloadUrl: mediaInfo.url,
    accessToken,
  })

  const safeMime = storageSafeMimeType(
    contentType || mediaInfo.mimeType || mimeType,
  )

  const { error: uploadErr } = await db.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, buffer, {
      cacheControl: '31536000',
      upsert: true,
      contentType: safeMime,
    })
  if (uploadErr) {
    throw new Error(`Inbound media upload failed: ${uploadErr.message}`)
  }

  const {
    data: { publicUrl },
  } = db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path)

  if (!publicUrl || !/^https?:\/\//i.test(publicUrl)) {
    throw new Error(`Invalid public URL after inbound upload: ${publicUrl}`)
  }

  if (rewriteMessageUrls) {
    await rewriteProxyUrls(db, mediaId, publicUrl)
  }

  return publicUrl
}

/**
 * If Storage already has this object, return its public URL; otherwise null.
 * Used by the media route for a fast redirect without Meta.
 */
export async function getCachedInboundMediaUrl(
  db: SupabaseClient,
  accountId: string,
  mediaId: string,
): Promise<string | null> {
  const path = inboundMediaStoragePath(accountId, mediaId)
  const {
    data: { publicUrl },
  } = db.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path)
  if (!publicUrl) return null
  if (await isPublicObjectPresent(publicUrl)) return publicUrl
  return null
}

async function isPublicObjectPresent(publicUrl: string): Promise<boolean> {
  try {
    const res = await fetch(publicUrl, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function rewriteProxyUrls(
  db: SupabaseClient,
  mediaId: string,
  publicUrl: string,
): Promise<void> {
  const proxy = proxyMediaUrl(mediaId)
  const { error } = await db
    .from('messages')
    .update({ media_url: publicUrl })
    .eq('media_url', proxy)
  if (error) {
    console.warn(
      '[persist-inbound-media] failed to rewrite media_url:',
      error.message,
    )
  }
}
