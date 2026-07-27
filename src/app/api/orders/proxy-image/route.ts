import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { catalogBaseUrl } from '@/lib/catalog/products'

/**
 * GET /api/orders/proxy-image?url=…
 * Fetches a catalog image server-side so html-to-image can embed it (CORS).
 * Only allows ladiesbags catalog hosts.
 */
export async function GET(request: Request) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const raw = new URL(request.url).searchParams.get('url')?.trim()
  if (!raw) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 })
  }

  let target: URL
  try {
    target = new URL(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 })
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return NextResponse.json({ error: 'Unsupported protocol' }, { status: 400 })
  }

  const allowedHosts = new Set<string>()
  try {
    allowedHosts.add(new URL(catalogBaseUrl()).hostname)
  } catch {
    /* ignore */
  }
  allowedHosts.add('www.ladiesbags.lk')
  allowedHosts.add('ladiesbags.lk')
  allowedHosts.add('img.ladiesbags.lk')
  // Local / staging catalog during development
  allowedHosts.add('localhost')
  allowedHosts.add('127.0.0.1')

  if (!allowedHosts.has(target.hostname)) {
    return NextResponse.json({ error: 'Host not allowed' }, { status: 403 })
  }

  try {
    const upstream = await fetch(target.toString(), {
      cache: 'force-cache',
      headers: { Accept: 'image/*,*/*' },
    })
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Upstream image HTTP ${upstream.status}` },
        { status: 502 },
      )
    }
    const contentType = upstream.headers.get('content-type') || 'image/jpeg'
    if (!contentType.startsWith('image/')) {
      return NextResponse.json({ error: 'Not an image' }, { status: 400 })
    }
    const buf = await upstream.arrayBuffer()
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Proxy failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
