import { describe, expect, it } from 'vitest'
import {
  extractOrderIntents,
  parseColorOnlyReply,
  productDisplayName,
  resolveOrderIntentsForAddress,
} from './order-intent'
import { isAddressLikeMessage } from './actions/orders'
import { buildProductNeedles, type MatchableQuickReply } from './match-products'

const cloudy: MatchableQuickReply = {
  id: '1',
  title: 'Cloudy Shoulder Bag Details Quick Reply',
  description: null,
  kind: 'catalog',
  product_id: 'cloudy',
  catalog_message_id: 'qm_site_prod_cloudy',
  needles: buildProductNeedles(
    'Cloudy Shoulder Bag Details Quick Reply',
    'cloudy',
  ),
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

  it('detects bare address block without saying address', () => {
    const bare = `Chamod
No 280
Uttalapura
Dehiattakandiya
0779522100`
    expect(isAddressLikeMessage(bare)).toBe(true)
  })

  it('resolves bag from text when address-only follows prior ask', () => {
    const intents = resolveOrderIntentsForAddress({
      customerTexts: [
        'Chamod\nNo 280\nUttalapura\nDehiattakandiya\n0779522100',
        'mata cloudy black oni',
      ],
      catalog: [cloudy],
      offeredProducts: [cloudy],
    })
    expect(intents[0]?.name.toLowerCase()).toContain('cloudy')
    expect(intents[0]?.color?.toLowerCase()).toBe('black')
  })

  it('uses offered product when customer texts have no bag name', () => {
    const intents = resolveOrderIntentsForAddress({
      customerTexts: [
        'Chamod\nNo 280\nUttalapura\nDehiattakandiya\n0779522100',
      ],
      catalog: [cloudy],
      offeredProducts: [cloudy],
    })
    expect(intents).toHaveLength(1)
    expect(intents[0].color).toBeNull()
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
  })

  it('strips quick reply suffix from title', () => {
    expect(productDisplayName('Cloudy Shoulder Bag Details Quick Reply')).toBe(
      'Cloudy Shoulder Bag',
    )
  })
})
