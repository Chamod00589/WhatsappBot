import { describe, expect, it } from 'vitest'
import {
  extractColorsFromText,
  extractOrderIntents,
  parseColorOnlyReply,
  productDisplayName,
} from './order-intent'
import { buildProductNeedles, type MatchableQuickReply } from './match-products'

const cloudy: MatchableQuickReply = {
  id: '1',
  title: 'Cloudy Shoulder Bag Details Quick Reply',
  description: null,
  kind: 'catalog',
  product_id: 'cloudy',
  catalog_message_id: 'qm_site_prod_cloudy',
  needles: buildProductNeedles('Cloudy Shoulder Bag Details Quick Reply', 'cloudy'),
}

describe('order-intent', () => {
  it('extracts bag + black color from singlish buy message', () => {
    const text =
      'Mata cloudy black color bag ekak oni\n\nChamod\nNo 280\nUttalapura\nDehiattakandiya\n0779522100'
    const intents = extractOrderIntents([text], [cloudy])
    expect(intents).toHaveLength(1)
    expect(intents[0].name.toLowerCase()).toContain('cloudy')
    expect(intents[0].color?.toLowerCase()).toBe('black')
  })

  it('uses prior bag request when address-only follows', () => {
    const intents = extractOrderIntents(
      [
        'Chamod\nNo 280\nUttalapura\nDehiattakandiya\n0779522100',
        'Mata cloudy black color bag ekak oni',
      ],
      [cloudy],
    )
    expect(intents[0]?.color?.toLowerCase()).toBe('black')
  })

  it('detects missing color', () => {
    const intents = extractOrderIntents(
      ['mata cloudy bag ekak ganna puluwanda?'],
      [cloudy],
    )
    expect(intents[0]?.color).toBeNull()
  })

  it('parses color-only reply', () => {
    expect(parseColorOnlyReply('black')).toBe('Black')
    expect(parseColorOnlyReply('Black color')).toBe('Black')
    expect(parseColorOnlyReply('mata cloudy black bag ekak oni')).toBeNull()
  })

  it('extracts colors', () => {
    expect(extractColorsFromText('cloudy white bag')).toContain('White')
  })

  it('strips quick reply suffix from title', () => {
    expect(productDisplayName('Cloudy Shoulder Bag Details Quick Reply')).toBe(
      'Cloudy Shoulder Bag',
    )
  })
})
