import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { clearAgentHistoryForConversation } from '@/lib/sales-agent/clear-agent-history'

/**
 * POST /api/conversations/[id]/reset-agent
 *
 * Clears Sales Agent session memory and inserts a *** cutoff marker so
 * prior turns are ignored — inbox equivalent of the customer sending ***.
 */
export async function POST(
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
    const result = await clearAgentHistoryForConversation({
      db: ctx.supabase,
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
