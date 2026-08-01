export type ReplyMode = 'singlish' | 'tanglish'

/** Detect Tamil Unicode script. */
export function hasTamilScript(text: string): boolean {
  return /[\u0B80-\u0BFF]/.test(text)
}

/** Detect Sinhala Unicode script. */
export function hasSinhalaScript(text: string): boolean {
  return /[\u0D80-\u0DFF]/.test(text)
}

/** Latin text that looks like Tanglish (Tamil typed in English letters). */
export function looksLikeTanglish(text: string): boolean {
  const t = text.toLowerCase()
  return /\b(unga|ungalukku|venum|venuma|iruku|irukka|sollu|sollunga|eppadi|evlo|evvalavu|bag venum|price sollu|delivery|seri|illai|illa|nandri|vanakkam|color|colour|address|phone)\b/.test(
    t,
  ) && /\b(unga|venum|iruku|sollu|eppadi|evlo|seri|illai|vanakkam)\b/.test(t)
}

/**
 * Heuristic: Latin text that looks like Singlish.
 */
export function looksLikeSinglish(text: string): boolean {
  const t = text.toLowerCase()
  return /\b(oyata|oyage|mokakda|mokadda|eka|needa|oni|onne|thama|karanna|denna|kohanada|kohomada|bag eka|price eka|delivery eka|hari|hariy|oyala|mata|wage|wenna|kochchara|kochcara|dawasak|dawas|yanwada|yanawada|ganna|dennako|puluvan|puluwang|nadda|neda|ehema|meka|eka da|kiyanna|thiyenawa|thiyena|enna|gihin|awilla|okada|hari da)\b/.test(
    t,
  )
}

/** Customer says they don't understand (switch to Tanglish). */
export function saysDontUnderstand(text: string): boolean {
  const t = text.toLowerCase()
  return (
    /\b(don'?t understand|do not understand|not understand|cant understand|can't understand)\b/.test(
      t,
    ) ||
    /\b(theren nae|therenne nae|bohoma amaru|amarui|english|sinhala balanna ba)\b/.test(
      t,
    ) ||
    /\b(puriyala|puriya|puriyavillai|puriyala|tamil la solunga|tamil la)\b/.test(t)
  )
}

/**
 * Always Singlish by default. Use Tanglish when the customer writes Tamil
 * / Tanglish, or says they don't understand.
 */
export function detectReplyMode(recentCustomerTexts: string[]): ReplyMode {
  const sample = recentCustomerTexts.slice(-8).join('\n')
  if (!sample.trim()) return 'singlish'
  if (hasTamilScript(sample) || looksLikeTanglish(sample)) return 'tanglish'
  if (saysDontUnderstand(sample)) return 'tanglish'
  return 'singlish'
}

/** @deprecated Prefer detectReplyMode — true when mode is singlish. */
export function shouldUseSinglish(recentCustomerTexts: string[]): boolean {
  return detectReplyMode(recentCustomerTexts) === 'singlish'
}

export function languageHintForPrompt(mode: ReplyMode): string {
  if (mode === 'tanglish') {
    return (
      'The customer prefers Tamil. ALWAYS reply in Tanglish (Tamil typed in Latin letters only), ' +
      'e.g. "Ungalukku venum bag ethu?". NEVER use Tamil Unicode script. Never use Sinhala Unicode.'
    )
  }
  return (
    'ALWAYS reply in Singlish using Latin letters only (e.g. "Oyata oni bag eka kiyanna"). ' +
    'NEVER use Sinhala Unicode script (never output characters like ඔයාට). ' +
    'Never use formal English only — keep it Singlish WhatsApp style.'
  )
}

/** Convenience: singlish vs tanglish short ask strings. */
export function askBagAddressText(mode: ReplyMode): string {
  if (mode === 'tanglish') {
    return 'Order pannanum na name, address, district, phone number anupunga.'
  }
  return 'Hari — order ekata name, address, district, phone number eka send karanna.'
}

export function askWhichBagText(mode: ReplyMode): string {
  if (mode === 'tanglish') {
    return 'Address kitten. Ungalukku ethu bag / color / qty venum? Bag name kooda anupunga.'
  }
  return 'Address eka hambuna. Mokakda bag eka, color eka, saha qty oyata oni? Bag name eka kiyanna.'
}

export function askColorAndQtyText(
  mode: ReplyMode,
  bagNames: string,
  availableColors?: string[],
): string {
  const colorHint =
    availableColors && availableColors.length
      ? availableColors.slice(0, 8).join(' / ')
      : 'black / white / pink…'
  if (mode === 'tanglish') {
    return `${bagNames} ku ethu color + qty venum? (${colorHint})`
  }
  return `${bagNames} eka ganna color eka saha qty kiyanna. (${colorHint})`
}

export function orderConfirmedText(mode: ReplyMode): string {
  if (mode === 'tanglish') {
    return 'Order confirm aagiruchu. Nandri!'
  }
  return 'Order eka confirm una. Thank you!'
}
