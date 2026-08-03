import { supabaseAdmin } from '@/lib/ai/admin-client'
import type { SalesAgentDispatchArgs } from './types'
import { dispatchSalesAgentNow } from './dispatch'
import { findTestMarkerCutoff } from './gates'
import {
  looksLikeImageReferentialText,
  looksLikeNamedProductLine,
} from './order-intent'

/** Quiet period after the last inbound before one Sales Agent pass.
 *  Each new message resets this timer (wait again 10s). */
const DEBOUNCE_MS = 10_000

type BurstPart = {
  text: string
  contentType: string
  mediaUrl?: string | null
  metaMediaId?: string | null
}

type ConversationBuffer = {
  timer: ReturnType<typeof setTimeout> | null
  parts: BurstPart[]
  base: SalesAgentDispatchArgs
  /** All webhook callers await this until the burst is processed. */
  waiters: Array<() => void>
}

const buffers = new Map<string, ConversationBuffer>()
/** Conversations currently running a Sales Agent dispatch. */
const inflight = new Set<string>()
/** Parts that arrived while a dispatch was already running. */
const pendingAfterInflight = new Map<string, ConversationBuffer>()

/**
 * Coalesce inbound messages for one conversation into a single Sales Agent
 * run. After each message, wait {@link DEBOUNCE_MS}; if another message
 * arrives, reset the wait. Only when 10s pass with no new message do we
 * flush the full burst. Webhook callers await this so `after()` stays alive.
 */
export async function enqueueSalesAgentDispatch(
  args: SalesAgentDispatchArgs,
): Promise<void> {
  const key = args.conversationId

  return new Promise<void>((resolve) => {
    const part: BurstPart = {
      text: args.inboundText || '',
      contentType: args.contentType,
      mediaUrl: args.mediaUrl,
      metaMediaId: args.metaMediaId,
    }

    // If a run is already in progress, queue for a follow-up burst
    // instead of starting a parallel reply on the same thread.
    if (inflight.has(key)) {
      let queued = pendingAfterInflight.get(key)
      if (!queued) {
        queued = {
          timer: null,
          parts: [],
          base: args,
          waiters: [],
        }
        pendingAfterInflight.set(key, queued)
      }
      queued.parts.push(part)
      queued.base = { ...args }
      queued.waiters.push(resolve)
      return
    }

    let buf = buffers.get(key)
    if (!buf) {
      buf = {
        timer: null,
        parts: [],
        base: args,
        waiters: [],
      }
      buffers.set(key, buf)
    }

    buf.parts.push(part)
    buf.base = { ...args }
    buf.waiters.push(resolve)

    if (buf.timer) clearTimeout(buf.timer)
    buf.timer = setTimeout(() => {
      void flushConversation(key)
    }, DEBOUNCE_MS)
  })
}

async function flushConversation(key: string): Promise<void> {
  const buf = buffers.get(key)
  if (!buf) return
  buffers.delete(key)
  if (buf.timer) {
    clearTimeout(buf.timer)
    buf.timer = null
  }

  inflight.add(key)
  try {
    const merged = await mergeBurstArgs(buf)
    await dispatchSalesAgentNow(merged)
  } catch (err) {
    console.error('[sales-agent] batched dispatch failed:', err)
  } finally {
    inflight.delete(key)
    for (const w of buf.waiters) w()

    // Process anything that arrived while we were running.
    const queued = pendingAfterInflight.get(key)
    if (queued && queued.parts.length) {
      pendingAfterInflight.delete(key)
      const next: ConversationBuffer = {
        timer: null,
        parts: queued.parts,
        base: queued.base,
        waiters: queued.waiters,
      }
      buffers.set(key, next)
      // Same 10s quiet window so trailing msgs join the next burst.
      next.timer = setTimeout(() => {
        void flushConversation(key)
      }, DEBOUNCE_MS)
    }
  }
}

/**
 * Prefer DB-backed burst (all customer msgs since last bot reply) so we
 * analyze everything even if debounce missed a concurrent webhook.
 * Fall back to the in-memory buffer texts.
 */
async function mergeBurstArgs(
  buf: ConversationBuffer,
): Promise<SalesAgentDispatchArgs> {
  const db = supabaseAdmin()
  const conversationId = buf.base.conversationId

  const { data: lastBot } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // *** resets the session — never pull customer texts from before it.
  const markerCutoff = await findTestMarkerCutoff(db, conversationId)

  let query = db
    .from('messages')
    .select('content_text, content_type, media_url, referral, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: true })
    .limit(20)

  const sinceCandidates = [
    lastBot?.created_at as string | undefined,
    markerCutoff || undefined,
  ].filter((v): v is string => Boolean(v))
  if (sinceCandidates.length) {
    // Use the later cutoff so *** wins over an older bot reply.
    const since = sinceCandidates.sort()[sinceCandidates.length - 1]
    // Include the *** message itself (gte) so "*** bag ask" stays in the burst.
    if (markerCutoff && since === markerCutoff) {
      query = query.gte('created_at', since)
    } else {
      query = query.gt('created_at', since)
    }
  } else {
    // New thread — only coalesce the last few minutes, not the whole history.
    query = query.gte(
      'created_at',
      new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    )
  }

  const { data: rows } = await query
  const dbTexts = (rows ?? [])
    .map((r) => (typeof r.content_text === 'string' ? r.content_text.trim() : ''))
    .filter(Boolean)

  const bufferTexts = buf.parts
    .map((p) => p.text.trim())
    .filter(Boolean)

  // Prefer the richer of DB vs buffer (DB usually wins for multi-webhook bursts).
  const texts = dbTexts.length >= bufferTexts.length ? dbTexts : bufferTexts
  const inboundText =
    texts.length > 0
      ? texts.join('\n')
      : bufferTexts.join('\n') || buf.base.inboundText

  // Collect ALL images in the burst with per-image captions.
  // Caption = image message text, or following text-only msg(s) until the next image.
  type ImgSlot = {
    mediaUrl?: string | null
    metaMediaId?: string | null
    caption: string
  }
  const inboundImages: ImgSlot[] = []
  const seen = new Set<string>()

  const imageKey = (
    mediaUrl?: string | null,
    metaMediaId?: string | null,
  ): string | null => {
    const extractedId =
      metaMediaId ||
      mediaUrl?.match(/\/api\/whatsapp\/media\/([^/?#]+)/)?.[1] ||
      null
    const key = `${extractedId || ''}|${mediaUrl || ''}`
    if (!key.replace('|', '')) return null
    return key
  }

  const appendCaption = (slot: ImgSlot, text: string) => {
    const t = text.trim()
    if (!t) return
    slot.caption = slot.caption ? `${slot.caption}\n${t}` : t
  }

  type ChronoEvent =
    | { kind: 'image'; mediaUrl?: string | null; metaMediaId?: string | null; text: string }
    | { kind: 'text'; text: string }

  const chrono: ChronoEvent[] = []

  // Prefer DB order when we have customer rows (covers multi-webhook bursts).
  if ((rows ?? []).length > 0) {
    for (const r of rows ?? []) {
      const text =
        typeof r.content_text === 'string' ? r.content_text.trim() : ''
      if (r.content_type === 'image') {
        const url = typeof r.media_url === 'string' ? r.media_url : null
        if (!url && !text) continue
        chrono.push({ kind: 'image', mediaUrl: url, metaMediaId: null, text })
      } else if (text) {
        chrono.push({ kind: 'text', text })
      }
    }
  } else {
    for (const p of buf.parts) {
      const text = (p.text || '').trim()
      const isImg = p.contentType === 'image' || !!p.metaMediaId || !!p.mediaUrl
      if (isImg) {
        chrono.push({
          kind: 'image',
          mediaUrl: p.mediaUrl,
          metaMediaId: p.metaMediaId,
          text,
        })
      } else if (text) {
        chrono.push({ kind: 'text', text })
      }
    }
  }

  // Merge in-memory image parts that DB missed (metaMediaId often only in buffer).
  // Match by URL / order to attach meta ids.
  if ((rows ?? []).length > 0 && buf.parts.length) {
    const bufImgs = buf.parts.filter(
      (p) => p.contentType === 'image' || p.metaMediaId || p.mediaUrl,
    )
    let bi = 0
    for (const ev of chrono) {
      if (ev.kind !== 'image') continue
      const bp = bufImgs[bi++]
      if (!bp) break
      if (!ev.metaMediaId && bp.metaMediaId) ev.metaMediaId = bp.metaMediaId
      if (!ev.mediaUrl && bp.mediaUrl) ev.mediaUrl = bp.mediaUrl
      if (!ev.text && bp.text?.trim()) ev.text = bp.text.trim()
    }
  }

  let lastImage: ImgSlot | null = null
  for (const ev of chrono) {
    if (ev.kind === 'image') {
      const key = imageKey(ev.mediaUrl, ev.metaMediaId)
      if (!key || seen.has(key)) {
        // Duplicate image — still attach caption text to previous matching slot
        if (ev.text && lastImage) appendCaption(lastImage, ev.text)
        continue
      }
      seen.add(key)
      const extractedId =
        ev.metaMediaId ||
        ev.mediaUrl?.match(/\/api\/whatsapp\/media\/([^/?#]+)/)?.[1] ||
        null
      const slot: ImgSlot = {
        mediaUrl: ev.mediaUrl ?? null,
        metaMediaId: extractedId,
        caption: ev.text || '',
      }
      inboundImages.push(slot)
      lastImage = slot
    } else if (lastImage) {
      // Only glue "this photo" lines onto the image caption.
      // Named product asks ("Mini shoulder red 1i") stay in burst text only.
      if (
        looksLikeNamedProductLine(ev.text) &&
        !looksLikeImageReferentialText(ev.text)
      ) {
        lastImage = null
        continue
      }
      appendCaption(lastImage, ev.text)
    }
  }

  // Buffer may have images the DB query hasn't persisted yet — append those.
  for (const p of buf.parts) {
    const isImg = p.contentType === 'image' || !!p.metaMediaId || !!p.mediaUrl
    if (!isImg) continue
    const key = imageKey(p.mediaUrl, p.metaMediaId)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const extractedId =
      p.metaMediaId ||
      p.mediaUrl?.match(/\/api\/whatsapp\/media\/([^/?#]+)/)?.[1] ||
      null
    const slot: ImgSlot = {
      mediaUrl: p.mediaUrl ?? null,
      metaMediaId: extractedId,
      caption: (p.text || '').trim(),
    }
    inboundImages.push(slot)
    lastImage = slot
  }

  let mediaUrl = buf.base.mediaUrl ?? null
  let metaMediaId = buf.base.metaMediaId ?? null
  let contentType = buf.base.contentType
  if (inboundImages.length) {
    const last = inboundImages[inboundImages.length - 1]
    mediaUrl = last.mediaUrl ?? mediaUrl
    metaMediaId = last.metaMediaId ?? metaMediaId
    contentType = 'image'
  }

  return {
    ...buf.base,
    inboundText,
    contentType,
    mediaUrl,
    metaMediaId,
    inboundImages,
    // Prefer a referral from any message in this burst (CTWA first msg).
    referral: pickBurstReferral(rows ?? [], buf.base.referral),
  }
}

function pickBurstReferral(
  rows: Array<{ referral?: unknown }>,
  fallback?: SalesAgentDispatchArgs['referral'],
): SalesAgentDispatchArgs['referral'] {
  for (const r of rows) {
    const ref = r.referral
    if (ref && typeof ref === 'object' && Object.keys(ref as object).length > 0) {
      return ref as NonNullable<SalesAgentDispatchArgs['referral']>
    }
  }
  if (fallback && typeof fallback === 'object' && Object.keys(fallback).length > 0) {
    return fallback
  }
  return null
}
