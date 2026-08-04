import { describe, expect, it } from 'vitest'
import { parseCartIntentJson } from './cart-intent-extract'
import {
  applyCartOperationToPending,
  applyColorOnlyToPending,
  canonicalizeExtractedColor,
  checkQuoteCompleteness,
  combineConfidence,
  heuristicLinesFromText,
  resolveExtractionItems,
  resolveMentionedProduct,
  validateProductColor,
  validateQty,
  CART_CONFIDENCE_AUTO,
  type ResolvedCartLine,
} from './cart-pipeline'
import {
  buildProductNeedles,
  type MatchableQuickReply,
} from './match-products'

// re-export check — buildProductNeedles lives in match-products; pipeline imports resolve via match
function catalogFixture(): MatchableQuickReply[] {
  return [
    {
      id: 'qr-mini',
      title: 'Mini Shoulder Bag Details Quick Reply',
      description: null,
      kind: 'catalog',
      product_id: 'mini-1',
      catalog_message_id: 'qm_site_prod_mini-1',
      needles: buildProductNeedles('Mini Shoulder Bag', 'mini-1', [
        'mini',
        'mini bag',
        'podi bag',
      ]),
      bagName: 'Mini Shoulder Bag',
      retailPrice: 990,
      colors: ['Black', 'White', 'Pink'],
      matchAliases: ['mini', 'mini bag', 'podi bag'],
    },
    {
      id: 'qr-cloudy',
      title: 'Cloudy Shoulder Bag Details Quick Reply',
      description: null,
      kind: 'catalog',
      product_id: 'cloudy-1',
      catalog_message_id: 'qm_site_prod_cloudy-1',
      needles: buildProductNeedles('Cloudy Shoulder Bag', 'cloudy-1', ['cloudy']),
      bagName: 'Cloudy Shoulder Bag',
      retailPrice: 2500,
      colors: ['White', 'Black', 'Pink'],
      matchAliases: ['cloudy'],
    },
  ]
}

describe('parseCartIntentJson', () => {
  it('parses catalog-selected items with productId + name', () => {
    const parsed = parseCartIntentJson({
      intent: 'quotation',
      operation: 'set',
      items: [
        {
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          mentioned: 'cloudy',
          qty: 2,
          color: 'White',
          confidence: 0.98,
        },
        {
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          mentioned: 'cloudy',
          qty: 1,
          color: 'Black',
          confidence: 0.98,
        },
      ],
      target: { mentioned: null, color: null },
    })
    expect(parsed.intent).toBe('quotation')
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0].productId).toBe('cloudy-1')
    expect(parsed.items[0].name).toBe('Cloudy Shoulder Bag')
    expect(parsed.items[0].qty).toBe(2)
    expect(parsed.items[1].color).toBe('Black')
  })

  it('returns none on garbage', () => {
    expect(parseCartIntentJson('not json').intent).toBe('none')
  })
})

describe('resolveExtractionItems with catalog productId', () => {
  it('resolves by productId without needle matching', () => {
    const resolved = resolveExtractionItems(
      {
        intent: 'quotation',
        operation: 'set',
        items: [
          {
            productId: 'cloudy-1',
            name: 'Cloudy Shoulder Bag',
            mentioned: 'cloudy white',
            qty: 2,
            color: 'White',
            confidence: 0.99,
          },
        ],
        target: { mentioned: null, color: null },
      },
      catalogFixture(),
    )
    expect(resolved.clarify).toBeUndefined()
    expect(resolved.lines[0]?.productId).toBe('cloudy-1')
    expect(resolved.lines[0]?.color).toBe('White')
    expect(resolved.lines[0]?.qty).toBe(2)
  })
})

describe('alias + resolveMentionedProduct', () => {
  it('resolves curated alias "podi bag" to Mini Shoulder Bag', () => {
    const { qr, matchConfidence } = resolveMentionedProduct(
      'podi bag eka',
      catalogFixture(),
    )
    expect(qr?.product_id).toBe('mini-1')
    expect(matchConfidence).toBeGreaterThan(0.7)
  })
})

describe('confidence gates', () => {
  it('combines LLM + match confidence', () => {
    expect(combineConfidence(0.7, 0.95)).toBeGreaterThanOrEqual(0.7)
    expect(combineConfidence(0.99, 0.5)).toBeGreaterThanOrEqual(0.9)
  })

  it('asks when mid confidence; auto when high', () => {
    const catalog = catalogFixture()
    const mid = resolveExtractionItems(
      {
        intent: 'quotation',
        operation: 'set',
        items: [
          { mentioned: 'mini bag', qty: 1, color: 'black', confidence: 0.7, productId: null, name: null },
        ],
        target: { mentioned: null, color: null },
      },
      catalog,
    )
    // unique strong needle may boost into auto — if still mid, clarify
    if (mid.clarify) {
      expect(['ambiguous_product', 'low_confidence']).toContain(
        mid.clarify.reason,
      )
    } else {
      expect(mid.lines[0]?.confidence).toBeGreaterThanOrEqual(
        CART_CONFIDENCE_AUTO,
      )
    }

    const high = resolveExtractionItems(
      {
        intent: 'quotation',
        operation: 'set',
        items: [
          { mentioned: 'mini bag', qty: 1, color: 'black', confidence: 0.99, productId: null, name: null },
        ],
        target: { mentioned: null, color: null },
      },
      catalog,
    )
    expect(high.clarify).toBeUndefined()
    expect(high.lines[0]?.productId).toBe('mini-1')
    expect(high.lines[0]?.color?.toLowerCase()).toBe('black')
  })
})

describe('color + qty validation', () => {
  it('canonicalizes Singlish colors', () => {
    expect(canonicalizeExtractedColor('kalu')).toMatch(/black/i)
    expect(canonicalizeExtractedColor('sudu')).toMatch(/white/i)
  })

  it('rejects colors not on the product', () => {
    const v = validateProductColor('Purple', ['Black', 'White', 'Pink'])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.available).toContain('Black')
  })

  it('rejects crazy qty', () => {
    expect(validateQty(200).ok).toBe(false)
    expect(validateQty(2).ok).toBe(true)
  })
})

describe('cart ops + completeness', () => {
  it('add_qty increases last line', () => {
    const existing = [
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'Black',
        qty: 1,
        price: 990,
      },
    ]
    const next = applyCartOperationToPending(
      existing,
      [
        {
          productId: 'mini-1',
          name: 'Mini Shoulder Bag',
          color: 'Black',
          qty: 2,
          confidence: 0.99,
        },
      ],
      'add_qty',
    )
    expect(next[0].qty).toBe(3)
  })

  it('remove drops the target line', () => {
    const existing = [
      {
        productId: 'mini-1',
        name: 'Mini',
        color: 'Black',
        qty: 1,
        price: 990,
      },
      {
        productId: 'cloudy-1',
        name: 'Cloudy',
        color: 'Pink',
        qty: 1,
        price: 2500,
      },
    ]
    const next = applyCartOperationToPending(
      existing,
      [
        {
          productId: 'mini-1',
          name: 'Mini',
          color: 'Black',
          qty: 1,
          confidence: 0.99,
        },
      ],
      'remove',
      { productId: 'mini-1', color: 'Black' },
    )
    expect(next).toHaveLength(1)
    expect(next[0].productId).toBe('cloudy-1')
  })

  it('never allows partial quotation (missing color)', () => {
    const lines: ResolvedCartLine[] = [
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: null,
        qty: 1,
        confidence: 0.99,
      },
    ]
    const c = checkQuoteCompleteness(lines, catalogFixture())
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toBe('missing_color')
  })

  it('passes complete lines', () => {
    const lines: ResolvedCartLine[] = [
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'Black',
        qty: 2,
        confidence: 0.99,
      },
    ]
    expect(checkQuoteCompleteness(lines, catalogFixture()).ok).toBe(true)
  })
})

describe('color-only reply onto pending', () => {
  it('applies Black onto pending Bloom line missing color', () => {
    const catalog: MatchableQuickReply[] = [
      ...catalogFixture(),
      {
        id: 'qr-bloom',
        title: 'Bloom Shoulder Bag Details Quick Reply',
        description: null,
        kind: 'catalog',
        product_id: 'bloom-1',
        catalog_message_id: 'qm_site_prod_bloom-1',
        needles: buildProductNeedles('Bloom Shoulder Bag', 'bloom-1', ['bloom']),
        bagName: 'Bloom Shoulder Bag',
        retailPrice: 1200,
        colors: ['White', 'Black', 'Brown', 'Pink', 'Tan'],
        matchAliases: ['bloom'],
      },
    ]
    const filled = applyColorOnlyToPending(
      [
        {
          productId: 'bloom-1',
          name: 'Bloom Shoulder Bag',
          color: '',
          qty: 1,
          price: 0,
        },
      ],
      'Black color',
      catalog,
    )
    expect(filled.applied).toBe(true)
    expect(filled.items[0].color).toBe('Black')
  })
})

describe('heuristic multi-color same bag', () => {
  it('parses Cloudy white 2i black 1kui denna into two lines', () => {
    const lines = heuristicLinesFromText(
      'Cloudy white 2i black 1kui denna',
      catalogFixture(),
    )
    expect(lines).toHaveLength(2)
    expect(lines[0].productId).toBe('cloudy-1')
    expect(lines[0].color?.toLowerCase()).toBe('white')
    expect(lines[0].qty).toBe(2)
    expect(lines[1].color?.toLowerCase()).toBe('black')
    expect(lines[1].qty).toBe(1)
  })
})

describe('buildProductNeedles with curated aliases', () => {
  it('includes curated aliases in needles', () => {
    const needles = buildProductNeedles('Mini Shoulder Bag', 'mini-1', [
      'podi bag',
      'mini',
    ])
    expect(needles.some((n) => n.includes('podi'))).toBe(true)
    expect(needles.some((n) => n === 'mini' || n.includes('mini'))).toBe(true)
  })
})
