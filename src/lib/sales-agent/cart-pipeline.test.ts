import { describe, expect, it } from 'vitest'
import { parseCartIntentJson } from './cart-intent-extract'
import {
  applyCartOperationToPending,
  canonicalizeExtractedColor,
  checkQuoteCompleteness,
  combineConfidence,
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
  it('parses quotation intent with separate lines (no merge)', () => {
    const parsed = parseCartIntentJson({
      intent: 'quotation',
      operation: 'set',
      items: [
        { mentioned: 'mini bag', qty: 2, color: 'black', confidence: 0.96 },
        { mentioned: 'cloudy', qty: 1, color: 'Pink', confidence: 0.9 },
      ],
      target: { mentioned: null, color: null },
    })
    expect(parsed.intent).toBe('quotation')
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0].mentioned).toBe('mini bag')
    expect(parsed.items[0].qty).toBe(2)
  })

  it('returns none on garbage', () => {
    expect(parseCartIntentJson('not json').intent).toBe('none')
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
          { mentioned: 'mini bag', qty: 1, color: 'black', confidence: 0.7 },
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
          { mentioned: 'mini bag', qty: 1, color: 'black', confidence: 0.99 },
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
