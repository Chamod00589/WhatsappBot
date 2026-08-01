import type { SupabaseClient } from '@supabase/supabase-js'
import {
  sendCatalogQuickReply,
  sendProductQuickReply,
} from '@/lib/whatsapp/product-quick-reply-send'
import { engineSendText } from '@/lib/flows/meta-send'
import { SendMessageError } from '@/lib/whatsapp/send-message'

/** Pause after one full QR so Meta finishes delivering before the next QR. */
const BETWEEN_QR_GAP_MS = 1500

/** Per-conversation chain — never overlap two catalog QR sends (avoids mixed images). */
const qrSendChains = new Map<string, Promise<unknown>>()

function enqueueQrSend<T>(
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = qrSendChains.get(conversationId) ?? Promise.resolve()
  const next = prev.then(task, task)
  // Keep chain alive even if this task fails
  qrSendChains.set(
    conversationId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Send a catalog (product or custom) quick reply and stamp ai_context_summary
 * on the stub message for compact Sales Agent context.
 *
 * Serialized per conversation: wait until this QR (all images) is fully
 * sent before another QR can start — prevents mixed product images.
 */
export async function sendQuickReplyByCatalogId(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  catalogMessageId: string
  contextSummary?: string
}): Promise<void> {
  const { db, accountId, conversationId, catalogMessageId, contextSummary } =
    args

  await enqueueQrSend(conversationId, async () => {
    const result = await sendCatalogQuickReply(db, accountId, {
      conversationId,
      catalogMessageId,
    })

    const summary =
      contextSummary?.trim() ||
      `Sent catalog quick reply: ${result.shortTitle || catalogMessageId}`

    if (result.stubMessageId) {
      await db
        .from('messages')
        .update({ ai_context_summary: summary })
        .eq('id', result.stubMessageId)
    } else {
      await stampLatestOutbound(db, conversationId, summary)
    }

    // Let Meta settle this QR's media before the next QR begins.
    await sleep(BETWEEN_QR_GAP_MS)
  })
}

export async function sendQuickReplyByProductId(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  productId: string
  contextSummary?: string
}): Promise<void> {
  await enqueueQrSend(args.conversationId, async () => {
    const result = await sendProductQuickReply(args.db, args.accountId, {
      conversationId: args.conversationId,
      productId: args.productId,
    })
    const summary =
      args.contextSummary?.trim() ||
      `Sent product quick reply: ${result.shortTitle || args.productId}`
    if (result.stubMessageId) {
      await args.db
        .from('messages')
        .update({ ai_context_summary: summary })
        .eq('id', result.stubMessageId)
    } else {
      await stampLatestOutbound(args.db, args.conversationId, summary)
    }
    await sleep(BETWEEN_QR_GAP_MS)
  })
}

/**
 * Send a local text quick reply (kind=text) via Meta + persist with summary.
 */
export async function sendLocalTextQuickReply(args: {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  contextSummary: string
  db: SupabaseClient
}): Promise<void> {
  await engineSendText({
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text: args.text,
    aiGenerated: true,
  })
  await stampLatestOutbound(args.db, args.conversationId, args.contextSummary)
}

async function stampLatestOutbound(
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

export function isSendErrorNotFound(err: unknown): boolean {
  return err instanceof SendMessageError && err.code === 'not_found'
}
