import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  createOrderOnLadiesbags,
  LadiesbagsOrdersError,
} from '@/lib/orders/ladiesbags-orders'

/**
 * POST /api/orders/create
 * Proxies ladiesbags POST /api/orders/create with server-side API key.
 */
export async function POST(request: Request) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  let body: {
    text?: string
    whatsapp_phone?: string
    payment_status?: string
    order_status?: string
    amount_paid?: number | string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }

  const payment_status =
    typeof body.payment_status === 'string' ? body.payment_status : 'pending'
  if (!['pending', 'half_payment', 'full_payment'].includes(payment_status)) {
    return NextResponse.json({ error: 'Invalid payment_status' }, { status: 400 })
  }

  const payload: {
    text: string
    whatsapp_phone?: string
    payment_status: string
    order_status?: string
    amount_paid?: number
  } = { text, payment_status }

  // Inbox creates unpaid orders as ChatBot (not Pending). Paid statuses stay half/full.
  if (payment_status === 'pending') {
    const orderStatus =
      typeof body.order_status === 'string' && body.order_status.trim()
        ? body.order_status.trim()
        : 'chatbot'
    if (!['pending', 'chatbot', 'web_order'].includes(orderStatus)) {
      return NextResponse.json({ error: 'Invalid order_status' }, { status: 400 })
    }
    payload.order_status = orderStatus
  }

  if (typeof body.whatsapp_phone === 'string' && body.whatsapp_phone.trim()) {
    payload.whatsapp_phone = body.whatsapp_phone.trim()
  }

  if (payment_status === 'half_payment') {
    const amount = Number(body.amount_paid)
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amount_paid is required for half_payment' },
        { status: 400 },
      )
    }
    payload.amount_paid = amount
  }

  try {
    const result = await createOrderOnLadiesbags(payload)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof LadiesbagsOrdersError) {
      return NextResponse.json(
        { error: err.message, ...(typeof err.body === 'object' && err.body ? err.body : {}) },
        { status: err.status >= 400 ? err.status : 502 },
      )
    }
    const msg = err instanceof Error ? err.message : 'Create order failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
