import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  LadiesbagsOrdersError,
  updateOrderOnLadiesbags,
} from '@/lib/orders/ladiesbags-orders'

/**
 * PATCH /api/orders/[id]
 * Proxies ladiesbags PATCH /api/orders/update for inbox order editing.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  if (!id?.trim()) {
    return NextResponse.json({ error: 'order id required' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    const result = await updateOrderOnLadiesbags(id.trim(), body)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof LadiesbagsOrdersError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 400 ? err.status : 502 },
      )
    }
    const msg = err instanceof Error ? err.message : 'Update failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
