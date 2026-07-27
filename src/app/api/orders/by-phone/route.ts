import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  fetchOrderByPhone,
  LadiesbagsOrdersError,
} from '@/lib/orders/ladiesbags-orders'

/**
 * GET /api/orders/by-phone?phone=…&days=…&whatsapp_only=1
 * Proxies ladiesbags order lookup (duplicate check + post-create screenshot).
 */
export async function GET(request: Request) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const url = new URL(request.url)
  const phone = url.searchParams.get('phone')?.trim()
  if (!phone) {
    return NextResponse.json({ error: 'phone is required' }, { status: 400 })
  }

  const daysRaw = url.searchParams.get('days')
  const days = daysRaw ? Math.max(0, parseInt(daysRaw, 10) || 0) : undefined
  const whatsappOnly = url.searchParams.get('whatsapp_only') === '1'

  try {
    const result = await fetchOrderByPhone({
      phone,
      days: days || undefined,
      whatsappOnly,
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof LadiesbagsOrdersError) {
      return NextResponse.json({ error: err.message }, { status: err.status >= 400 ? err.status : 502 })
    }
    const msg = err instanceof Error ? err.message : 'Lookup failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
