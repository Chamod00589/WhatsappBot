/**
 * Normalize customer text for product / question matching.
 */
export function normalizeMatchText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0D80-\u0DFF]+/g, ' ') // drop Sinhala script for Latin matching
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fingerprint a customer question for dedupe (same Q twice → one reply).
 */
export function questionFingerprint(text: string): string {
  const n = normalizeMatchText(text)
  if (!n) return ''
  // Drop filler words that don't change intent.
  const stop = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'do',
    'does',
    'can',
    'please',
    'pls',
    'me',
    'my',
    'i',
    'you',
    'eka',
    'da',
    'ne',
  ])
  const tokens = n
    .split(' ')
    .filter((t) => t.length > 1 && !stop.has(t))
    .slice(0, 24)
  return tokens.join(' ')
}

export function isSameQuestion(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // Soft match: one contains the other and lengths are close.
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length < 6) return false
  return longer.includes(shorter) && longer.length - shorter.length <= 20
}
