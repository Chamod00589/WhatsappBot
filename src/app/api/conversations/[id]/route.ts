import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { deleteConversationForAccount } from '@/lib/inbox/delete-conversation'

/**
 * DELETE /api/conversations/[id]
 *
 * Hard-deletes the conversation and cascaded messages/reactions, removes
 * durable chat-media objects referenced by those messages, and keeps the
 * contact (a later inbound message recreates an empty thread).
 *
 * Requires agent+ (same bar as conversations_delete RLS).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    if (!id?.trim()) {
      return NextResponse.json(
        { error: 'Conversation id is required' },
        { status: 400 },
      )
    }

    const ctx = await requireRole('agent')
    const result = await deleteConversationForAccount(ctx.supabase, {
      conversationId: id,
      accountId: ctx.accountId,
    })

    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    if (err instanceof Error && err.message === 'Conversation not found') {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    return toErrorResponse(err)
  }
}
