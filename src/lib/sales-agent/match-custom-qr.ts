import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeMatchText } from './normalize'

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

  return ((data ?? []) as CustomQuickReply[]).filter((r) => {
    if (r.kind === 'text' || r.kind === 'interactive') return true
    // Catalog custom (no product)
    if (r.kind === 'catalog' && !r.product_id) return true
    return false
  }).map((r) => ({
    ...r,
    description: (r.description || '').trim(),
  }))
}

export interface CustomMatch {
  qr: CustomQuickReply
  score: number
}

/**
 * Score custom QRs by overlap between customer text and description (+ title).
 * Uses description primarily as specified in the plan.
 */
export function matchCustomQuickReplies(
  text: string,
  catalog: CustomQuickReply[],
  opts?: { minScore?: number },
): CustomMatch[] {
  const minScore = opts?.minScore ?? 0.35
  const hay = normalizeMatchText(text)
  if (!hay || hay.length < 3) return []

  const hayTokens = new Set(hay.split(' ').filter((t) => t.length > 2))
  const results: CustomMatch[] = []

  for (const qr of catalog) {
    const desc = normalizeMatchText(qr.description || '')
    const title = normalizeMatchText(qr.title || '')
    if (!desc && !title) continue

    const descScore = tokenOverlap(hayTokens, desc)
    const titleScore = tokenOverlap(hayTokens, title) * 0.6
    // Phrase containment bonus
    let bonus = 0
    if (desc && (hay.includes(desc) || desc.includes(hay))) bonus += 0.25
    for (const phrase of significantPhrases(desc)) {
      if (phrase.length >= 6 && hay.includes(phrase)) bonus += 0.2
    }

    const score = Math.min(1, Math.max(descScore, titleScore) + bonus)
    if (score >= minScore) results.push({ qr, score })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

function tokenOverlap(hayTokens: Set<string>, corpus: string): number {
  if (!corpus) return 0
  const tokens = corpus.split(' ').filter((t) => t.length > 2)
  if (tokens.length === 0) return 0
  let hit = 0
  for (const t of tokens) {
    if (hayTokens.has(t)) hit += 1
  }
  return hit / tokens.length
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
