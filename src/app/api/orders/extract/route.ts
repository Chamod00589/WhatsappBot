import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { AiError } from '@/lib/ai/types'
import { geminiAddressPrompt } from '@/lib/orders/constants'

const EXTRACT_SYSTEM_PROMPT =
  'You extract customer delivery details for Sri Lankan shipping labels. Follow the user instructions exactly. Output only the requested @@ format — no markdown, no commentary, no blank lines.'

/**
 * POST /api/orders/extract
 * Body: { text: string }
 *
 * Formats address text into the Create-Order @@ block using the account's
 * Agents → Setup provider + API key (same BYO key as draft / playground).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-order-extract:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(
      `ai-order-extract-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount,
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

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

    const config = await loadAiConfig(supabase, accountId, {
      // Same as playground: work once the key is saved, even if master switch is off.
      requireActive: false,
    }).catch((err) => {
      console.error('[orders/extract] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })

    if (!config) {
      return NextResponse.json(
        {
          error:
            'No AI provider key saved. Add your API key in Agents → Setup, then try again.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const { text: reply, usage } = await generateReply({
      config,
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: geminiAddressPrompt(text) }],
    })

    const trimmed = (reply || '').trim()
    if (!trimmed) {
      return NextResponse.json(
        { error: 'AI returned an empty result.', code: 'empty_reply' },
        { status: 502 },
      )
    }

    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId: null,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      })
    } catch {
      /* never fail extract on usage logging */
    }

    return NextResponse.json({ success: true, reply: trimmed })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
