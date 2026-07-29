import type { ReplyMode } from './language'

export function identifyRejectText(mode: ReplyMode | boolean): string {
  const tanglish = mode === 'tanglish' || mode === false
  return tanglish
    ? 'Seri — vera photo illa bag name anupunga.'
    : 'Hari — venath photo ekak ho bag name eka send karanna.'
}

export function identifyConfirmAskText(
  product: string,
  color: string,
  confidence: number,
  mode: ReplyMode | boolean,
): string {
  const pct = Math.round(confidence)
  const tanglish = mode === 'tanglish' || mode === false
  if (tanglish) {
    return `Idhu thaan unga bag-a? ${product} — ${color} (match ~${pct}%). Seri na "ok" anupunga.`
  }
  return `Me bag eka da oyata oni? ${product} — ${color} (match ~${pct}%). Hari nam reply karanna "ok".`
}
