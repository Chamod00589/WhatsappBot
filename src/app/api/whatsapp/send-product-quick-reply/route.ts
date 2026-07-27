import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { SendMessageError } from '@/lib/whatsapp/send-message'
import { sendCatalogQuickReply } from '@/lib/whatsapp/product-quick-reply-send'

/**
 * Send a catalog quick-reply (product or custom from ladiesbags admin).
 * Uses JPEG public links when Prepare JPEGs was run; CRM stores short title only.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const conversationId =
    typeof body.conversation_id === 'string' ? body.conversation_id : ''
  const quickReplyId =
    typeof body.quick_reply_id === 'string' ? body.quick_reply_id : ''

  if (!conversationId || !quickReplyId) {
    return NextResponse.json(
      { error: 'conversation_id and quick_reply_id are required' },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()
  const { data: qr, error: qrErr } = await db
    .from('quick_replies')
    .select('*')
    .eq('id', quickReplyId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (qrErr) {
    return NextResponse.json({ error: qrErr.message }, { status: 500 })
  }
  if (!qr) {
    return NextResponse.json({ error: 'Quick reply not found' }, { status: 404 })
  }

  const catalogMessageId =
    (typeof qr.catalog_message_id === 'string' && qr.catalog_message_id) ||
    (qr.kind === 'product' && qr.product_id
      ? `qm_site_prod_${qr.product_id}`
      : null)

  if (
    (qr.kind !== 'catalog' && qr.kind !== 'product') ||
    !catalogMessageId
  ) {
    return NextResponse.json(
      { error: 'Not a catalog / product quick reply' },
      { status: 400 },
    )
  }

  try {
    const result = await sendCatalogQuickReply(db, ctx.accountId, {
      conversationId,
      catalogMessageId,
      stubTitle: qr.title,
    })

    const status =
      result.imagesSent === 0 && !result.textSent
        ? 502
        : result.failures.length && result.imagesSent < result.imagesAttempted
          ? 207
          : 200

    return NextResponse.json(
      {
        ok: result.ok,
        stub_message_id: result.stubMessageId,
        short_title: result.shortTitle,
        product_id: result.productId,
        product_name: result.productName,
        images_attempted: result.imagesAttempted,
        images_sent: result.imagesSent,
        text_sent: result.textSent,
        used_direct_links: result.usedDirectLinks,
        used_upload_convert: result.usedUploadConvert,
        failures: result.failures,
        sent: result.imagesSent || (result.textSent ? 1 : 0),
      },
      { status },
    )
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    const msg = err instanceof Error ? err.message : 'Send failed'
    console.error('[send-product-quick-reply]', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
