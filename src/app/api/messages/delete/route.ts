import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { softDeleteMessagesForAccount } from '@/lib/inbox/soft-delete-messages'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

/**
 * POST /api/messages/delete
 *
 * Body: { conversation_id: string, message_ids: string[] }
 *
 * Soft-deletes messages for everyone in the shared inbox (tombstone).
 * Meta Cloud API cannot remove them from the customer's WhatsApp.
 *
 * Requires agent+.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(
      `messagesDelete:${ctx.userId}`,
      RATE_LIMITS.messagesDelete,
    )
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = (await request.json()) as {
      conversation_id?: string
      message_ids?: string[]
    }

    const conversationId = body.conversation_id?.trim()
    const messageIds = Array.isArray(body.message_ids)
      ? body.message_ids.filter((id) => typeof id === 'string' && id.trim())
      : []

    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 },
      )
    }
    if (messageIds.length === 0) {
      return NextResponse.json(
        { error: 'message_ids is required' },
        { status: 400 },
      )
    }

    const result = await softDeleteMessagesForAccount(ctx.supabase, {
      conversationId,
      accountId: ctx.accountId,
      messageIds,
      deletedBy: ctx.userId,
    })

    return NextResponse.json({
      ok: true,
      deleted_ids: result.deletedIds,
      deleted_count: result.deletedIds.length,
    })
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Conversation not found') {
        return NextResponse.json({ error: err.message }, { status: 404 })
      }
      if (
        err.message === 'No messages to delete' ||
        err.message === 'Too many messages (max 100)'
      ) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
    }
    return toErrorResponse(err)
  }
}
