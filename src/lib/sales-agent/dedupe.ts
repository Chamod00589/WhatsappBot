import type { SupabaseClient } from '@supabase/supabase-js'
import { isSameQuestion, questionFingerprint } from './normalize'

/**
 * Returns true when this inbound looks like a repeat of a question
 * we already answered recently — caller should skip re-replying.
 */
export async function shouldSkipDuplicateQuestion(
  db: SupabaseClient,
  conversationId: string,
  inboundText: string,
  previousFp: string | null,
): Promise<boolean> {
  const fp = questionFingerprint(inboundText)
  if (!fp || fp.length < 6) return false
  if (!previousFp) return false
  return isSameQuestion(fp, previousFp)
}

export async function rememberAnsweredQuestion(
  db: SupabaseClient,
  conversationId: string,
  inboundText: string,
): Promise<void> {
  const fp = questionFingerprint(inboundText)
  if (!fp) return
  await db
    .from('conversations')
    .update({
      sa_last_question_fp: fp,
      sa_last_answered_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
}
