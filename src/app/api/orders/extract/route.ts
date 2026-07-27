import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { geminiAddressPrompt } from '@/lib/orders/constants'
import {
  extractCustomerViaGemini,
  LadiesbagsOrdersError,
} from '@/lib/orders/ladiesbags-orders'

/**
 * POST /api/orders/extract
 * Body: { text: string }
 * Proxies ladiesbags Gemini with the Create-Order address prompt.
 */
export async function POST(request: Request) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  let text = ''
  try {
    const body = await request.json()
    text = typeof body?.text === 'string' ? body.text.trim() : ''
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 })
  }

  try {
    const reply = await extractCustomerViaGemini(geminiAddressPrompt(text))
    return NextResponse.json({ success: true, reply })
  } catch (err) {
    if (err instanceof LadiesbagsOrdersError) {
      return NextResponse.json({ error: err.message }, { status: err.status >= 400 ? err.status : 502 })
    }
    const msg = err instanceof Error ? err.message : 'Extract failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
