import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/sales-agent/runs?conversationId=…
 * Latest Sales Agent debug runs for a conversation (troubleshoot panel).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const conversationId = url.searchParams.get('conversationId')?.trim()
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 },
      )
    }

    const limit = Math.min(
      20,
      Math.max(1, Number(url.searchParams.get('limit')) || 8),
    )

    // Ensure conversation belongs to this account
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { data, error } = await supabase
      .from('sales_agent_runs')
      .select(
        'id, status, skip_reason, inbound_text, content_type, payload, created_at, finished_at',
      )
      .eq('conversation_id', conversationId)
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[sales-agent/runs]', error)
      return NextResponse.json(
        { error: 'Failed to load runs', detail: error.message },
        { status: 500 },
      )
    }

    return NextResponse.json({ runs: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
