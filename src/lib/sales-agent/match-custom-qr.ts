import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeMatchText } from './normalize'
import { KNOWN_COLORS } from './order-intent'
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
 * Load custom (non-product) quick replies for description matching.
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
      // Catalog custom (no product)
      if (r.kind === 'catalog' && !r.product_id) return true
      return false
    })
    .map((r) => ({
      ...r,
      description: (r.description || '').trim(),
    }))
}

export interface CustomMatch {
  qr: CustomQuickReply
  score: number
}

const COLOR_TOKENS = new Set(
  KNOWN_COLORS.map((c) => normalizeMatchText(c)).filter(Boolean),
)

/**
 * Score custom QRs by overlap between customer question and QR **description**.
 * Description is required for a strong match (title alone is weak).
 * Skips order-edit / bare color-change asks so we don't fire "White bags" FAQ.
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
    // Prefer description — title-only matches need a higher bar
    if (!desc && !title) continue

    const descScore = desc ? tokenOverlapMeaningful(hayTokens, desc) : 0
    const titleScore = title ? tokenOverlapMeaningful(hayTokens, title) * 0.45 : 0

    let bonus = 0
    if (desc && (hay.includes(desc) || desc.includes(hay))) bonus += 0.3
    for (const phrase of significantPhrases(desc)) {
      if (phrase.length >= 8 && hay.includes(phrase)) bonus += 0.25
    }

    // Require description signal for FAQ QRs; title-only rarely correct
    let score = Math.min(1, Math.max(descScore, titleScore) + bonus)
    if (!desc || desc.length < 8) {
      score *= 0.5
    }
    // Pure color-token overlap with "White bags…" descriptions → reject
    if (descScore > 0 && onlyColorOverlap(hayTokens, desc)) {
      score *= 0.2
    }

    if (score >= minScore) results.push({ qr, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

function onlyColorOverlap(hayTokens: Set<string>, corpus: string): boolean {
  const tokens = corpus.split(' ').filter((t) => t.length > 2)
  const hits = tokens.filter((t) => hayTokens.has(t))
  if (!hits.length) return false
  return hits.every((t) => COLOR_TOKENS.has(t) || t === 'bags' || t === 'bag')
}

function tokenOverlapMeaningful(
  hayTokens: Set<string>,
  corpus: string,
): number {
  if (!corpus) return 0
  const tokens = corpus.split(' ').filter((t) => t.length > 2)
  if (tokens.length === 0) return 0
  let hit = 0
  let weight = 0
  for (const t of tokens) {
    const w = COLOR_TOKENS.has(t) ? 0.25 : 1
    weight += w
    if (hayTokens.has(t)) hit += w
  }
  return weight > 0 ? hit / weight : 0
}

function significantPhrases(desc: string): string[] {
  const words = desc.split(' ').filter(Boolean)
  const out: string[] = []
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      out.push(words.slice(i, i + n).join(' '))
    }
  }
  return out
}
