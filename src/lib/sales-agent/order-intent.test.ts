import { describe, expect, it } from 'vitest'
import {
  applyPendingOverridesToItems,
  extractOrderIntents,
  extractQty,
  looksLikeImageReferentialText,
  looksLikeNamedProductLine,
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
  it('parses Singlish Nk as quantity (3k ganna → 3)', () => {
    expect(
      extractQty('Mata cloudy black bag 3k ganna oni. Price kohomda'),
    ).toBe(3)
    expect(extractQty('bag 2k ganna oni')).toBe(2)
    expect(extractQty('thunak bag oni')).toBe(3)
    expect(extractQty('qty 4')).toBe(4)
    expect(extractQty('mata bag ekak oni')).toBe(1)
    expect(extractQty('Mini sholder red 1i oni')).toBe(1)
    expect(extractQty('Mata me bag 2k oni')).toBe(2)
  })

  it('splits image-referential captions from named product lines', () => {
    expect(looksLikeImageReferentialText('Mata me bag 2k oni')).toBe(true)
    expect(looksLikeImageReferentialText('meka white karanna')).toBe(true)
    expect(looksLikeNamedProductLine('Mini sholder red 1i oni')).toBe(true)
    expect(looksLikeNamedProductLine('Mata me bag 2k oni')).toBe(false)
  })

  it('prefers pending identify color over wrong model color', () => {
    const fixed = applyPendingOverridesToItems(
      [
        { name: 'Bloom Shoulder Bag', color: 'black', qty: 2, price: 2500 },
        { name: 'Mini Shoulder Bag', color: 'red', qty: 1, price: 1800 },
      ],
      [
        {
          productId: 'bloom',
          name: 'Bloom Shoulder Bag',
          color: 'White',
          qty: 2,
          price: 2500,
        },
      ],
    )
    expect(fixed[0].color).toBe('White')
    expect(fixed[0].qty).toBe(2)
    expect(fixed[1].color).toBe('red')
  })

  it('keeps explicit add color when pending has another color for same bag', () => {
    const fixed = applyPendingOverridesToItems(
      [{ name: 'Cloudy Shoulder Bag', color: 'Black', qty: 2, price: 2500 }],
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'White',
          qty: 1,
          price: 2500,
        },
      ],
      { preserveExplicitColor: true },
    )
    expect(fixed[0].color).toBe('Black')
    expect(fixed[0].qty).toBe(2)
  })

  it('uses per-message qty when multiple bags mentioned separately', () => {
    const bloom: MatchableQuickReply = {
      id: '2',
      title: 'Bloom Shoulder Bag Details Quick Reply',
      description: null,
      kind: 'catalog',
      product_id: 'bloom',
      catalog_message_id: 'qm_site_prod_bloom',
      needles: buildProductNeedles(
        'Bloom Shoulder Bag Details Quick Reply',
        'bloom',
      ),
    }
    const intents = extractOrderIntents(
      ['cloudy black 2k ganna', 'bloom pink 3k ganna'],
      [cloudy, bloom],
    )
    expect(intents).toHaveLength(2)
    const byName = Object.fromEntries(
      intents.map((i) => [i.name.toLowerCase(), i.qty]),
    )
    expect(byName['cloudy shoulder bag']).toBe(2)
    expect(byName['bloom shoulder bag']).toBe(3)
  })

  it('uses qty 3 from 3k in quotation-style buy ask', () => {
    const text = 'Mata cloudy black bag 3k ganna oni. Price kohomda'
    const intents = extractOrderIntents([text], [cloudy])
    expect(intents).toHaveLength(1)
    expect(intents[0].qty).toBe(3)
    expect(intents[0].color?.toLowerCase()).toBe('black')
  })

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

  it('detects Dulakshi-style address (name / place / phone, no labels)', () => {
    const bare = `Dulakshi 
Thamuttegama 
Deweni piyawara
0778851020`
    expect(isAddressLikeMessage(bare)).toBe(true)
  })

  it('prefers bag+color from chat history over offered when address follows', () => {
    const intents = resolveOrderIntentsForAddress({
      customerTexts: [
        'Dulakshi\nThamuttegama\nDeweni piyawara\n0778851020',
        'cloudy eke black eka ganna puluwanda',
      ],
      catalog: [cloudy],
      offeredProducts: [],
    })
    expect(intents).toHaveLength(1)
    expect(intents[0]?.name.toLowerCase()).toContain('cloudy')
    expect(intents[0]?.color?.toLowerCase()).toBe('black')
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
