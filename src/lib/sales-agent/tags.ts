import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addContactTagIfAbsent,
  removeContactTag,
} from '@/lib/contacts/tag-write'

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
