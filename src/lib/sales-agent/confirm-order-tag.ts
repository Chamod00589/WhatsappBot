import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText } from '@/lib/flows/meta-send'
import { addNamedTag, contactHasNamedTag, removeNamedTag } from './tags'

const CONFIRM_OK =
  /^(ok|okay|yes|y|yeah|confirm|confirmed|hari|hariy|ow|correct)\b/i

/**
 * If contact is Pending and customer confirms the order screenshot,
 * swap Pending → Confirmed.
 */
export async function maybeConfirmOrderTag(args: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  inboundText: string
  useSinglish: boolean
}): Promise<boolean> {
  const {
    db,
    accountId,
    contactId,
    configOwnerUserId,
    conversationId,
    inboundText,
    useSinglish,
  } = args

  if (!CONFIRM_OK.test(inboundText.trim())) return false

  const pending = await contactHasNamedTag(db, accountId, contactId, 'Pending')
  if (!pending) return false

  await removeNamedTag(db, accountId, contactId, 'Pending')
  await addNamedTag(db, accountId, contactId, 'Confirmed')

  await engineSendText({
    accountId,
    userId: configOwnerUserId,
    conversationId,
    contactId,
    text: useSinglish
      ? 'Order eka confirm una. Thank you!'
      : 'Your order is confirmed. Thank you!',
    aiGenerated: true,
  })
  return true
}
