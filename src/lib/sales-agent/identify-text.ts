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
  const colorLabel = (color || '').trim()

  if (!colorLabel) {
    // Product matched via multi-color / product-only catalog shot — ask color.
    return tanglish
      ? `Idhu ${product} maari theriyuthu (match ~${pct}%). Ethana color venum? Seri bag na "ok" + color anupunga.`
      : `Me ${product} wage pennawa (match ~${pct}%). Color eka mona da? Hari nam "ok" kiyala color eka dannna.`
  }

  if (tanglish) {
    return `Idhu thaan unga bag-a? ${product} — ${colorLabel} (match ~${pct}%). Seri na "ok" anupunga.`
  }
  return `Me bag eka da oyata oni? ${product} — ${colorLabel} (match ~${pct}%). Hari nam reply karanna "ok".`
}

/** After high-confidence product match with unknown color. */
export function identifyAskColorText(
  product: string,
  mode: ReplyMode | boolean,
): string {
  const tanglish = mode === 'tanglish' || mode === false
  return tanglish
    ? `${product} match aachu — ethana color venum?`
    : `${product} match una — color eka mona da?`
}
