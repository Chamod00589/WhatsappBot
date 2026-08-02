import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addContactTagIfAbsent,
  removeContactTag,
} from '@/lib/contacts/tag-write'

const UNREAD_TAG_COLOR = '#ef4444'

async function findTagIdByName(
  db: SupabaseClient,
  accountId: string,
  name: string,
): Promise<string | null> {
  const { data } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', name)
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

/**
 * Find a tag by name, or create it (account-scoped) when missing.
 * Used for system tags like "Unread" that must exist for agent failures.
 */
export async function ensureNamedTagId(
  db: SupabaseClient,
  accountId: string,
  name: string,
  opts: { ownerUserId: string; color?: string },
): Promise<string | null> {
  const existing = await findTagIdByName(db, accountId, name)
  if (existing) return existing

  const { data: maxRow } = await db
    .from('tags')
    .select('sort_order')
    .eq('account_id', accountId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextSort = (Number(maxRow?.sort_order) || 0) + 1

  const { data, error } = await db
    .from('tags')
    .insert({
      user_id: opts.ownerUserId,
      account_id: accountId,
      name,
      color: opts.color || UNREAD_TAG_COLOR,
      sort_order: nextSort,
    })
    .select('id')
    .maybeSingle()

  if (error) {
    // Race: another request created it — re-find
    const again = await findTagIdByName(db, accountId, name)
    if (again) return again
    console.warn(`[sales-agent] ensure tag "${name}" failed:`, error.message)
    return null
  }
  return data?.id ?? null
}

export async function addNamedTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  name: string,
): Promise<boolean> {
  const tagId = await findTagIdByName(db, accountId, name)
  if (!tagId) {
    console.warn(`[sales-agent] tag "${name}" not found for account`)
    return false
  }
  return addContactTagIfAbsent(db, { accountId, contactId, tagId })
}

/**
 * Mark a chat that the Sales Agent saw but could not answer:
 * add "Unread" tag (create tag if needed) and bump unread_count.
 */
export async function markAgentUnableToReply(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  ownerUserId: string
}): Promise<void> {
  const { db, accountId, conversationId, contactId, ownerUserId } = args

  const tagId = await ensureNamedTagId(db, accountId, 'Unread', {
    ownerUserId,
    color: UNREAD_TAG_COLOR,
  })
  if (tagId) {
    try {
      await addContactTagIfAbsent(db, { accountId, contactId, tagId })
    } catch (err) {
      console.warn('[sales-agent] add Unread tag failed:', err)
    }
  }

  const { data: conv } = await db
    .from('conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .maybeSingle()
  const current = Number(conv?.unread_count) || 0
  if (current < 1) {
    await db
      .from('conversations')
      .update({ unread_count: 1 })
      .eq('id', conversationId)
  }
}

export async function removeNamedTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  name: string,
): Promise<void> {
  const tagId = await findTagIdByName(db, accountId, name)
  if (!tagId) return
  await removeContactTag(db, { accountId, contactId, tagId })
}

export async function contactHasNamedTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  name: string,
): Promise<boolean> {
  const tagId = await findTagIdByName(db, accountId, name)
  if (!tagId) return false
  const { data } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId)
    .eq('tag_id', tagId)
    .limit(1)
    .maybeSingle()
  return Boolean(data)
}
