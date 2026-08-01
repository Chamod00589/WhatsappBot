import { supabaseAdmin } from '@/lib/ai/admin-client'
import type { SalesAgentDispatchArgs } from './types'
import { dispatchSalesAgentNow } from './dispatch'

/** Wait this long after the last inbound before analyzing the burst. */
const DEBOUNCE_MS = 2200

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
 * Coalesce rapid inbound messages for one conversation into a single
 * Sales Agent run. Webhook callers should await this so `after()` keeps
 * the isolate alive through the debounce + reply.
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
      // Short settle so a trailing msg in the same second joins this burst.
      next.timer = setTimeout(() => {
        void flushConversation(key)
      }, Math.min(800, DEBOUNCE_MS))
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

  let query = db
    .from('messages')
    .select('content_text, content_type, media_url, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: true })
    .limit(20)

  if (lastBot?.created_at) {
    query = query.gt('created_at', lastBot.created_at)
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

  // Latest image in the burst (buffer order), else base args.
  let mediaUrl = buf.base.mediaUrl ?? null
  let metaMediaId = buf.base.metaMediaId ?? null
  let contentType = buf.base.contentType
  for (const p of buf.parts) {
    if (p.contentType === 'image' || p.metaMediaId || p.mediaUrl) {
      contentType = p.contentType || 'image'
      mediaUrl = p.mediaUrl ?? mediaUrl
      metaMediaId = p.metaMediaId ?? metaMediaId
    }
  }

  return {
    ...buf.base,
    inboundText,
    contentType,
    mediaUrl,
    metaMediaId,
  }
}
