/** Detect Sinhala Unicode script in text. */
export function hasSinhalaScript(text: string): boolean {
  return /[\u0D80-\u0DFF]/.test(text)
}

/**
 * Heuristic: Latin text that looks like Singlish (common particles /
 * bag-shop phrases without being proper English-only).
 */
export function looksLikeSinglish(text: string): boolean {
  const t = text.toLowerCase()
  return /\b(oyata|oyage|mokakda|mokadda|eka|needa|oni|onne|thama|karanna|denna|kohanada|kohomada|bag eka|price eka|delivery eka|hari|hariy|oyala|mata|wage)\b/.test(
    t,
  )
}

/** Prefer Singlish Latin replies when the conversation is Sinhala/Singlish. */
export function shouldUseSinglish(recentCustomerTexts: string[]): boolean {
  const sample = recentCustomerTexts.slice(-8).join('\n')
  if (!sample.trim()) return false
  if (hasSinhalaScript(sample)) return true
  if (looksLikeSinglish(sample)) return true
  return false
}

export function languageHintForPrompt(useSinglish: boolean): string {
  if (useSinglish) {
    return (
      'The customer is writing in Sinhala or Singlish. ALWAYS reply in Singlish ' +
      'using Latin letters only (e.g. "Oyata oni bag eka mokakda"). ' +
      'NEVER use Sinhala Unicode script (never output characters like ඔයාට).'
    )
  }
  return (
    'Reply in the same language the customer is using. Keep WhatsApp replies short.'
  )
}
