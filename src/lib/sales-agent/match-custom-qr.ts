import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeMatchText } from './normalize'
import { isMostlyColorAsk, isOrderEditRequest } from './order-edit-intent'

export interface CustomQuickReply {
  id: string
  title: string
  description: string
  kind: string
  content_text: string | null
  catalog_message_id: string | null
  product_id: string | null
}

/**
 * Load custom (non-product) quick replies for the Sales Agent FAQ list.
 * Includes local text/interactive QRs and catalog customs (no product_id).
 */
export async function loadCustomQuickReplies(
  db: SupabaseClient,
  accountId: string,
): Promise<CustomQuickReply[]> {
  const { data, error } = await db
    .from('quick_replies')
    .select(
      'id, title, description, kind, content_text, catalog_message_id, product_id',
    )
    .eq('account_id', accountId)

  if (error) throw error

  return ((data ?? []) as CustomQuickReply[])
    .filter((r) => {
      if (r.kind === 'text' || r.kind === 'interactive') return true
      if (r.kind === 'catalog' && !r.product_id) return true
      return false
    })
    .map((r) => ({
      ...r,
      description: (r.description || '').trim(),
    }))
}

/**
 * Resolve a custom QR by id or catalog message id (LLM picks from the FAQ list).
 */
export function findCustomQuickReply(
  catalog: CustomQuickReply[],
  args: { quickReplyId?: string; catalogMessageId?: string },
): CustomQuickReply | null {
  const qrId = args.quickReplyId?.trim() || ''
  const catalogId = args.catalogMessageId?.trim() || ''
  if (qrId) {
    const byId = catalog.find((q) => q.id === qrId)
    if (byId) return byId
  }
  if (catalogId) {
    const byCat = catalog.find((q) => q.catalog_message_id === catalogId)
    if (byCat) return byCat
  }
  return null
}

export interface CustomMatch {
  qr: CustomQuickReply
  score: number
}

/**
 * Lightweight guard used only to block color-edit asks from matching FAQ
 * cards (e.g. "White bags"). Intent matching for delivery/policy is done
 * by the LLM via quick_reply_id — not by token synonyms.
 */
export function matchCustomQuickReplies(
  text: string,
  catalog: CustomQuickReply[],
  opts?: { minScore?: number },
): CustomMatch[] {
  const minScore = opts?.minScore ?? 0.45
  if (isOrderEditRequest(text) || isMostlyColorAsk(text)) return []

  const hay = normalizeMatchText(text)
  if (!hay || hay.length < 3) return []

  const hayTokens = new Set(hay.split(' ').filter((t) => t.length > 2))
  const results: CustomMatch[] = []

  for (const qr of catalog) {
    const desc = normalizeMatchText(qr.description || '')
    const title = normalizeMatchText(qr.title || '')
    if (!desc && !title) continue

    const corpus = desc || title
    const tokens = corpus.split(' ').filter((t) => t.length > 2)
    if (!tokens.length) continue
    let hit = 0
    for (const t of tokens) {
      if (hayTokens.has(t)) hit += 1
    }
    const score = hit / tokens.length
    if (score >= minScore) results.push({ qr, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}
