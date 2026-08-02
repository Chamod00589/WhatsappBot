import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MediaDownloadTimeoutError } from '@/lib/whatsapp/meta-api'
import {
  getCachedInboundMediaUrl,
  persistInboundWhatsAppMedia,
  proxyMediaUrl,
} from '@/lib/whatsapp/persist-inbound-media'

/** Rare path: only first view of historical proxy URLs hits Meta. */
export const maxDuration = 60

/**
 * Legacy inbound media proxy.
 *
 * New inbound messages persist to Supabase Storage in the webhook and
 * store a public URL on `messages.media_url`. This route remains for:
 *   1) older rows still pointing at `/api/whatsapp/media/<id>`
 *   2) webhook persist failures (fallback proxy path)
 *
 * Behaviour (cost-conscious):
 *   - If Storage already has the object → 302 redirect (short function)
 *   - Else download from Meta once, upload, rewrite DB, 302 redirect
 *   - Never stream Meta bytes through Vercel after the first persist
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mediaId: string }> },
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 },
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const admin = supabaseAdmin()

    // Fast path: already persisted → redirect to CDN (no Meta, tiny bill).
    const cached = await getCachedInboundMediaUrl(admin, accountId, mediaId)
    if (cached) {
      await admin
        .from('messages')
        .update({ media_url: cached })
        .eq('media_url', proxyMediaUrl(mediaId))
      return NextResponse.redirect(cached, 302)
    }

    const { data: config, error: configError } = await admin
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)
    const publicUrl = await persistInboundWhatsAppMedia({
      db: admin,
      accountId,
      mediaId,
      accessToken,
      rewriteMessageUrls: true,
    })

    return NextResponse.redirect(publicUrl, 302)
  } catch (error) {
    if (error instanceof MediaDownloadTimeoutError) {
      console.warn('WhatsApp media download timed out')
      return NextResponse.json(
        { error: 'Media download timed out' },
        { status: 504 },
      )
    }
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 },
    )
  }
}
