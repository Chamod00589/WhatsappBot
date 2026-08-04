import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { editMessageForAccount } from '@/lib/inbox/edit-message'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

/**
 * POST /api/messages/edit
 *
 * Body: { conversation_id, message_id, content_text }
 *
 * Edits an outbound text/caption in the shared inbox (15-minute window).
 * Meta Cloud API cannot update the customer's WhatsApp copy.
 *
 * Requires agent+.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(
      `messagesEdit:${ctx.userId}`,
      RATE_LIMITS.messagesEdit,
    )
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = (await request.json()) as {
      conversation_id?: string
      message_id?: string
      content_text?: string
    }

    const conversationId = body.conversation_id?.trim()
    const messageId = body.message_id?.trim()
    const contentText =
      typeof body.content_text === 'string' ? body.content_text : ''

    if (!conversationId || !messageId) {
      return NextResponse.json(
        { error: 'conversation_id and message_id are required' },
        { status: 400 },
      )
    }

    const result = await editMessageForAccount(ctx.supabase, {
      conversationId,
      accountId: ctx.accountId,
      messageId,
      contentText,
      editedBy: ctx.userId,
    })

    return NextResponse.json({
      ok: true,
      message_id: result.messageId,
      content_text: result.contentText,
      edited_at: result.editedAt,
    })
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message === 'Conversation not found' ||
        err.message === 'Message not found'
      ) {
        return NextResponse.json({ error: err.message }, { status: 404 })
      }
      if (
        err.message === 'Message text is required' ||
        err.message === 'Message text is too long (max 4096)' ||
        err.message === 'Cannot edit a deleted message' ||
        err.message.startsWith('Only outbound')
      ) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
    }
    return toErrorResponse(err)
  }
}
