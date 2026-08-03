import type { MessageReferral } from '@/types'

/**
 * Format CTWA / FB ads referral for the Sales Agent LLM and product
 * matchers. Ad copy often names the bag when the customer only sends a
 * generic greeting ("Hi", "more info?").
 */
export function formatAdReferralForAgent(
  referral: MessageReferral | null | undefined,
): string | null {
  if (!referral || typeof referral !== 'object') return null

  const parts: string[] = []
  const headline =
    typeof referral.headline === 'string' ? referral.headline.trim() : ''
  const body = typeof referral.body === 'string' ? referral.body.trim() : ''
  const sourceType =
    typeof referral.source_type === 'string' ? referral.source_type.trim() : ''

  if (headline) parts.push(`Ad title: ${headline}`)
  if (body) parts.push(`Ad text: ${body.slice(0, 800)}`)
  if (sourceType) parts.push(`Ad source: ${sourceType}`)

  if (!parts.length) return null
  return (
    `[Customer opened this chat from a Facebook/Instagram ad — use the ad to identify which product they mean]\n` +
    parts.join('\n')
  )
}

/** Combine customer message text with ad referral context. */
export function withAdReferralText(
  messageText: string | null | undefined,
  referral: MessageReferral | null | undefined,
): string {
  const ad = formatAdReferralForAgent(referral)
  const text = typeof messageText === 'string' ? messageText.trim() : ''
  if (ad && text) return `${ad}\nCustomer message: ${text}`
  if (ad) return ad
  return text
}
