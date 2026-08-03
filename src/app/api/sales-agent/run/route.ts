import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { dispatchSalesAgentNow } from '@/lib/sales-agent'
import type { MessageReferral } from '@/types'

/**
 * POST /api/sales-agent/run  (agent+)
 *
 * Manual "Reply with AI" from a paused inbox thread. Collects unanswered
 * customer messages since the last agent/bot reply and runs the Sales
 * Agent once with `forceManual` (bypasses pause / Human / assigned gates).
 * The conversation stays paused for humans afterward.
 *
 * Body: { conversationId: string }
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`sa-manual:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const conversationId =
      typeof body?.conversationId === 'string' ? body.conversationId.trim() : ''
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversationId is required' },
        { status: 400 },
      )
    }

    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id, contact_id, account_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (convErr) {
      console.error('[sales-agent/run] conversation lookup:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv?.contact_id) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const burst = await loadUnansweredCustomerBurst(supabase, conversationId)
    if (!burst.hasUnanswered) {
      return NextResponse.json(
        {
          error: 'No unanswered customer messages to reply to.',
          hasUnanswered: false,
        },
        { status: 400 },
      )
    }

    // Keep the HTTP response snappy; agent tools may take a while.
    after(async () => {
      try {
        await dispatchSalesAgentNow({
          accountId,
          conversationId,
          contactId: conv.contact_id,
          configOwnerUserId: userId,
          inboundText: burst.text,
          contentType: burst.contentType,
          mediaUrl: burst.mediaUrl,
          metaMediaId: burst.metaMediaId,
          inboundImages: burst.inboundImages,
          referral: burst.referral,
          forceManual: true,
        })
      } catch (err) {
        console.error('[sales-agent/run] dispatch failed:', err)
      }
    })

    return NextResponse.json({
      success: true,
      queued: true,
      hasUnanswered: true,
      preview: burst.text.slice(0, 200),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function loadUnansweredCustomerBurst(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  conversationId: string,
): Promise<{
  hasUnanswered: boolean
  text: string
  contentType: string
  mediaUrl: string | null
  metaMediaId: string | null
  inboundImages: Array<{
    mediaUrl?: string | null
    metaMediaId?: string | null
    caption?: string | null
  }>
  referral: MessageReferral | null
}> {
  const empty = {
    hasUnanswered: false,
    text: '',
    contentType: 'text',
    mediaUrl: null as string | null,
    metaMediaId: null as string | null,
    inboundImages: [] as Array<{
      mediaUrl?: string | null
      metaMediaId?: string | null
      caption?: string | null
    }>,
    referral: null as MessageReferral | null,
  }

  const { data: lastOutbound } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let query = db
    .from('messages')
    .select('content_text, content_type, media_url, referral, created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: true })
    .limit(30)

  if (lastOutbound?.created_at) {
    query = query.gt('created_at', lastOutbound.created_at)
  }

  const { data: rows } = await query
  const list = (rows ?? []) as Array<{
    content_text: string | null
    content_type: string
    media_url: string | null
    referral: MessageReferral | null
  }>

  if (!list.length) return empty

  const texts = list
    .map((r) => (typeof r.content_text === 'string' ? r.content_text.trim() : ''))
    .filter(Boolean)

  const inboundImages = list
    .filter((r) => r.content_type === 'image' && r.media_url)
    .map((r) => ({
      mediaUrl: r.media_url,
      metaMediaId:
        r.media_url?.match(/\/api\/whatsapp\/media\/([^/?#]+)/)?.[1] ?? null,
      caption: r.content_text,
    }))

  let referral: MessageReferral | null = null
  for (const r of list) {
    if (
      r.referral &&
      typeof r.referral === 'object' &&
      Object.keys(r.referral).length
    ) {
      referral = r.referral
      break
    }
  }

  const last = list[list.length - 1]
  const mediaUrl =
    last?.content_type === 'image' && last.media_url ? last.media_url : null

  return {
    hasUnanswered: Boolean(texts.length || inboundImages.length),
    text: texts.join('\n'),
    contentType: inboundImages.length ? 'image' : 'text',
    mediaUrl,
    metaMediaId: mediaUrl?.match(/\/api\/whatsapp\/media\/([^/?#]+)/)?.[1] ?? null,
    inboundImages,
    referral,
  }
}
