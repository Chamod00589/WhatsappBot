import type { Message } from '@/types'

/**
 * Best customer message text to seed Create Order from the open thread.
 * Priority: explicit seed → browser text selection → latest address-like inbound.
 */
export function resolveCreateOrderSeedText(options: {
  explicitSeed?: string | null
  messages: Message[]
  /** Pass window.getSelection()?.toString() from the click handler. */
  browserSelection?: string | null
}): string {
  const explicit = (options.explicitSeed || '').trim()
  if (explicit) return explicit

  const selected = (options.browserSelection || '').trim()
  if (selected.length >= 8) return selected

  return findLikelyCustomerAddressMessage(options.messages) || ''
}

/** Score inbound text for looking like shipping / contact details. */
export function findLikelyCustomerAddressMessage(
  messages: Message[],
): string | null {
  const candidates = messages
    .filter(
      (m) =>
        m.sender_type === 'customer' &&
        typeof m.content_text === 'string' &&
        m.content_text.trim().length >= 10,
    )
    .slice(-25) // recent window
    .reverse()

  let best: { text: string; score: number } | null = null

  for (const m of candidates) {
    const text = m.content_text!.trim()
    const score = scoreAddressLikeText(text)
    if (score < 2) continue
    if (!best || score > best.score) {
      best = { text, score }
    }
    // Strong match in the most recent messages — take it immediately.
    if (score >= 6) break
  }

  return best?.text ?? null
}

function scoreAddressLikeText(text: string): number {
  let score = 0
  const lower = text.toLowerCase()

  if (/📌|name\s*:|address\s*:|district\s*:|contact\s*0?\d/i.test(text)) {
    score += 5
  }
  if (/\b0\d{9}\b|\+94\s?\d{9}/.test(text.replace(/[\s-]/g, ''))) {
    score += 3
  } else if (/\d{9,10}/.test(text.replace(/\D/g, ''))) {
    score += 1
  }
  if (
    /road|lane|street|avenue|junction|pura|watta|gama|city|district|පාර|මාවත|ගම|නගරය/i.test(
      text,
    )
  ) {
    score += 2
  }
  if ((text.match(/\n/g) || []).length >= 1) score += 1
  if ((text.match(/,/g) || []).length >= 2) score += 1
  if (text.length >= 40) score += 1
  if (text.length >= 80) score += 1

  // Avoid short product questions / yes-no.
  if (/^(ok|okay|yes|no|hi|hello|thanks|thank you)\b/i.test(lower) && text.length < 30) {
    score -= 5
  }

  return score
}
