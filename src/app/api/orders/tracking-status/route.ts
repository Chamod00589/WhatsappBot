import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  LadiesbagsOrdersError,
  ladiesbagsOrdersRequest,
} from '@/lib/orders/ladiesbags-orders'

/**
 * GET /api/orders/tracking-status?trackingNo=…
 * Proxies ladiesbags public Domex status (+ branch contact) for inbox send.
 */
export async function GET(request: Request) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const url = new URL(request.url)
  const trackingNo = (
    url.searchParams.get('trackingNo') ??
    url.searchParams.get('track') ??
    ''
  ).trim()
  if (!trackingNo) {
    return NextResponse.json(
      { error: 'trackingNo is required' },
      { status: 400 },
    )
  }

  try {
    // Public ladiesbags endpoint — no ORDERS_API_KEY required.
    const result = await ladiesbagsOrdersRequest(
      'GET',
      '/api/domex/status',
      {
        query: { trackingNo },
        auth: false,
      },
    )
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof LadiesbagsOrdersError) {
      return NextResponse.json(
        { error: err.message, ...(typeof err.body === 'object' && err.body ? err.body : {}) },
        { status: err.status >= 400 ? err.status : 502 },
      )
    }
    const msg = err instanceof Error ? err.message : 'Tracking lookup failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
