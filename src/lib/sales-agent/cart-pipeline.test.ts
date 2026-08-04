import { describe, expect, it } from 'vitest'
import { parseCartIntentJson } from './cart-intent-extract'
import {
  applyCartActionsToPending,
  applyCartOperationToPending,
  applyColorOnlyToPending,
  applyColorSwapToPending,
  canonicalizeExtractedColor,
  checkQuoteCompleteness,
  coerceCartOperation,
  combineConfidence,
  heuristicLinesFromText,
  looksLikeAbsoluteQtyDesire,
  looksLikeColorRemoveRequest,
  mergeDuplicatePendingLines,
  mergePhotoPendingIntoResolved,
  parseColorSwapRequest,
  resolveCartActions,
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
      colors: ['White', 'Black', 'Pink', 'Brown'],
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
    expect(parsed.actions).toHaveLength(2)
    expect(parsed.actions.every((a) => a.type === 'set')).toBe(true)
    expect(parsed.items).toHaveLength(2)
    expect(parsed.items[0].productId).toBe('cloudy-1')
    expect(parsed.items[0].name).toBe('Cloudy Shoulder Bag')
    expect(parsed.items[0].qty).toBe(2)
    expect(parsed.items[1].color).toBe('Black')
  })

  it('parses ordered actions for remove+add color replace', () => {
    const parsed = parseCartIntentJson({
      intent: 'edit_cart',
      actions: [
        {
          type: 'remove',
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          mentioned: 'White color eka',
          color: 'White',
          qty: null,
          confidence: 0.95,
        },
        {
          type: 'add',
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          mentioned: 'brown 3k',
          color: 'Brown',
          qty: 3,
          confidence: 0.95,
        },
      ],
    })
    expect(parsed.intent).toBe('edit_cart')
    expect(parsed.actions).toHaveLength(2)
    expect(parsed.actions[0].type).toBe('remove')
    expect(parsed.actions[0].color).toBe('White')
    expect(parsed.actions[1].type).toBe('add')
    expect(parsed.actions[1].color).toBe('Brown')
    expect(parsed.actions[1].qty).toBe(3)
  })

  it('legacy add+target different color becomes remove then add', () => {
    const parsed = parseCartIntentJson({
      intent: 'edit_cart',
      operation: 'add',
      items: [
        {
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          mentioned: 'brown',
          qty: 3,
          color: 'Brown',
          confidence: 0.95,
        },
      ],
      target: { color: 'White', mentioned: 'White color eka' },
    })
    expect(parsed.actions[0].type).toBe('remove')
    expect(parsed.actions[0].color).toBe('White')
    expect(parsed.actions[1].type).toBe('add')
    expect(parsed.actions[1].color).toBe('Brown')
    expect(parsed.actions[1].qty).toBe(3)
  })

  it('returns none on garbage', () => {
    expect(parseCartIntentJson('not json').intent).toBe('none')
  })
})

describe('resolveExtractionItems with catalog productId', () => {
  it('resolves by productId without needle matching', () => {
    const resolved = resolveExtractionItems(
      parseCartIntentJson({
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
      }),
      catalogFixture(),
    )
    expect(resolved.clarify).toBeUndefined()
    expect(resolved.lines[0]?.productId).toBe('cloudy-1')
    expect(resolved.lines[0]?.color).toBe('White')
    expect(resolved.lines[0]?.qty).toBe(2)
  })
})

describe('applyCartActionsToPending remove+add', () => {
  it('removes White and adds Brown x3 without touching Red (bug regression)', () => {
    const existing = [
      {
        productId: 'shoulder-1',
        name: 'Shoulder Bag',
        color: 'Red',
        qty: 2,
        price: 850,
      },
      {
        productId: 'cloudy-1',
        name: 'Cloudy Shoulder Bag',
        color: 'White',
        qty: 1,
        price: 2500,
      },
    ]
    const extracted = parseCartIntentJson({
      intent: 'edit_cart',
      operation: 'add',
      items: [
        {
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          mentioned: 'brown',
          qty: 3,
          color: 'Brown',
          confidence: 0.95,
        },
      ],
      target: { color: 'White', mentioned: 'White color eka' },
    })
    const { actions, clarify } = resolveCartActions(
      extracted.actions,
      catalogFixture(),
    )
    expect(clarify).toBeUndefined()
    const next = applyCartActionsToPending(existing, actions)
    expect(next).toHaveLength(2)
    expect(next.find((l) => l.color === 'Red')?.qty).toBe(2)
    expect(next.find((l) => l.color === 'White')).toBeUndefined()
    expect(next.find((l) => l.color === 'Brown')?.qty).toBe(3)
    expect(next.find((l) => l.color === 'Brown')?.productId).toBe('cloudy-1')
  })

  it('executes explicit actions[] remove then add', () => {
    const existing = [
      {
        productId: 'cloudy-1',
        name: 'Cloudy Shoulder Bag',
        color: 'White',
        qty: 1,
        price: 2500,
      },
    ]
    const { actions } = resolveCartActions(
      parseCartIntentJson({
        intent: 'edit_cart',
        actions: [
          {
            type: 'remove',
            color: 'White',
            productId: 'cloudy-1',
            mentioned: 'white',
            confidence: 0.99,
          },
          {
            type: 'add',
            productId: 'cloudy-1',
            name: 'Cloudy Shoulder Bag',
            mentioned: 'brown',
            color: 'Brown',
            qty: 3,
            confidence: 0.99,
          },
        ],
      }).actions,
      catalogFixture(),
    )
    const next = applyCartActionsToPending(existing, actions)
    expect(next).toEqual([
      expect.objectContaining({
        productId: 'cloudy-1',
        color: 'Brown',
        qty: 3,
      }),
    ])
  })

  it('set_qty sets absolute qty without doubling', () => {
    const existing = [
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'Pink',
        qty: 2,
        price: 990,
      },
    ]
    const next = applyCartActionsToPending(existing, [
      {
        type: 'set_qty',
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'Pink',
        qty: 2,
        confidence: 0.99,
      },
    ])
    expect(next[0].qty).toBe(2)
  })
})

describe('mergePhotoPendingIntoResolved', () => {
  it('keeps Mini from identify when extract only returned Puff', () => {
    const merged = mergePhotoPendingIntoResolved(
      [
        {
          productId: 'mini-1',
          name: 'Mini Shoulder Bag',
          color: 'Black',
          qty: 1,
          price: 990,
        },
      ],
      [
        {
          productId: 'puff-1',
          name: 'Puff Shoulder Bag',
          color: 'Pink',
          qty: 2,
          confidence: 0.99,
        },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0].productId).toBe('mini-1')
    expect(merged[0].color?.toLowerCase()).toBe('black')
    expect(merged[0].qty).toBe(1)
    expect(merged[1].productId).toBe('puff-1')
    expect(merged[1].qty).toBe(2)
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
      parseCartIntentJson({
        intent: 'quotation',
        operation: 'set',
        items: [
          { mentioned: 'mini bag', qty: 1, color: 'black', confidence: 0.7, productId: null, name: null },
        ],
        target: { mentioned: null, color: null },
      }),
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
      parseCartIntentJson({
        intent: 'quotation',
        operation: 'set',
        items: [
          { mentioned: 'mini bag', qty: 1, color: 'black', confidence: 0.99, productId: null, name: null },
        ],
        target: { mentioned: null, color: null },
      }),
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

describe('validateProductColor variants', () => {
  it('does not collapse White_2 into White via substring soft-match', () => {
    const v = validateProductColor('White_2', ['White', 'White_2', 'Black'])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.color).toBe('White_2')
  })

  it('still matches Dark-Brown to dark brown', () => {
    const v = validateProductColor('dark brown', ['Dark-Brown', 'Black'])
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.color).toBe('Dark-Brown')
  })
})

describe('edit_cart add onto live order base (msg11 regression)', () => {
  it('adds photo bag onto live order lines without wiping them', () => {
    const liveOrder = [
      {
        productId: 'bloom-1',
        name: 'Bloom Shoulder Bag',
        color: 'White',
        qty: 2,
        price: 1200,
      },
      {
        productId: 'cloudy-1',
        name: 'Cloudy Shoulder Bag',
        color: 'White',
        qty: 1,
        price: 2500,
      },
    ]
    // Identify wrongly sat alone in pending as White_2; extract adds White
    const { actions } = resolveCartActions(
      parseCartIntentJson({
        intent: 'edit_cart',
        actions: [
          {
            type: 'add',
            productId: 'mini-1',
            name: 'Mini Shoulder Bag',
            mentioned: 'Me bag eka',
            color: 'White',
            qty: 1,
            confidence: 0.97,
          },
        ],
      }).actions,
      catalogFixture(),
    )
    const next = applyCartActionsToPending(liveOrder, actions)
    expect(next).toHaveLength(3)
    expect(next.find((l) => l.productId === 'bloom-1')?.qty).toBe(2)
    expect(next.find((l) => l.productId === 'cloudy-1')?.qty).toBe(1)
    expect(next.find((l) => l.productId === 'mini-1')?.color).toBe('White')
  })

  it('merges duplicate product+color after White_2/White style rows', () => {
    const merged = mergeDuplicatePendingLines([
      {
        productId: 'puff-1',
        name: 'Puff',
        color: 'White',
        qty: 1,
        price: 0,
      },
      {
        productId: 'puff-1',
        name: 'Puff',
        color: 'White',
        qty: 1,
        price: 0,
      },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].qty).toBe(2)
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

  it('replace_qty sets absolute qty on matching color line', () => {
    const existing = [
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'Pink',
        qty: 2,
        price: 990,
      },
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'White',
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
          color: 'Pink',
          qty: 2,
          confidence: 0.95,
        },
      ],
      'replace_qty',
      { productId: 'mini-1', color: 'Pink' },
    )
    expect(next).toHaveLength(2)
    expect(next.find((i) => i.color === 'Pink')?.qty).toBe(2)
    expect(next.find((i) => i.color === 'White')?.qty).toBe(1)
  })

  it('coerces LLM add → replace_qty for "Pink bag 2i oni" when pink already in cart', () => {
    const burst = 'Pink bag 2i oni. Meke 4k thiynawane'
    expect(looksLikeAbsoluteQtyDesire(burst)).toBe(true)
    expect(
      coerceCartOperation({
        burstText: burst,
        operation: 'add',
        intent: 'edit_cart',
        existing: [
          {
            productId: 'mini-1',
            name: 'Mini Shoulder Bag',
            color: 'Pink',
            qty: 2,
            price: 990,
          },
          {
            productId: 'mini-1',
            name: 'Mini Shoulder Bag',
            color: 'White',
            qty: 1,
            price: 990,
          },
        ],
        incoming: [
          {
            productId: 'mini-1',
            name: 'Mini Shoulder Bag',
            color: 'Pink',
            qty: 2,
            confidence: 0.95,
          },
        ],
      }),
    ).toBe('replace_qty')

    const coerced = coerceCartOperation({
      burstText: burst,
      operation: 'add',
      intent: 'edit_cart',
      existing: [
        {
          productId: 'mini-1',
          name: 'Mini Shoulder Bag',
          color: 'Pink',
          qty: 2,
          price: 990,
        },
      ],
      incoming: [
        {
          productId: 'mini-1',
          name: 'Mini Shoulder Bag',
          color: 'Pink',
          qty: 2,
          confidence: 0.95,
        },
      ],
    })
    const next = applyCartOperationToPending(
      [
        {
          productId: 'mini-1',
          name: 'Mini Shoulder Bag',
          color: 'Pink',
          qty: 2,
          price: 990,
        },
      ],
      [
        {
          productId: 'mini-1',
          name: 'Mini Shoulder Bag',
          color: 'Pink',
          qty: 2,
          confidence: 0.95,
        },
      ],
      coerced,
    )
    // Must stay 2 — not become 4 from add-merge
    expect(next[0].qty).toBe(2)
  })

  it('keeps add for ekakuth / thawa language', () => {
    expect(
      coerceCartOperation({
        burstText: 'White bag ekakuth ewanna',
        operation: 'add',
        intent: 'edit_cart',
        existing: [
          {
            productId: 'mini-1',
            name: 'Mini Shoulder Bag',
            color: 'Pink',
            qty: 2,
            price: 990,
          },
        ],
        incoming: [
          {
            productId: 'mini-1',
            name: 'Mini Shoulder Bag',
            color: 'White',
            qty: 1,
            confidence: 0.95,
          },
        ],
      }),
    ).toBe('add')
  })

  it('remove drops white by color even when extract named wrong bag', () => {
    const existing = [
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'Black',
        qty: 2,
        price: 990,
      },
      {
        productId: 'mini-1',
        name: 'Mini Shoulder Bag',
        color: 'White',
        qty: 1,
        price: 990,
      },
      {
        productId: 'cloudy-1',
        name: 'Cloudy Shoulder Bag',
        color: 'Black',
        qty: 3,
        price: 2500,
      },
    ]
    const next = applyCartOperationToPending(
      existing,
      [
        {
          productId: 'cloudy-1',
          name: 'Cloudy Shoulder Bag',
          color: 'White',
          qty: 1,
          confidence: 0.95,
        },
      ],
      'remove',
      { color: 'White' },
    )
    expect(next).toHaveLength(2)
    expect(next.every((l) => l.color.toLowerCase() !== 'white')).toBe(true)
    expect(next.find((l) => l.color === 'Black' && l.productId === 'mini-1')?.qty).toBe(
      2,
    )
  })

  it('looksLikeColorRemoveRequest detects sudu/white epa', () => {
    expect(
      looksLikeColorRemoveRequest(
        'Mata meke sudu pata eka epa. Anith tikata price eka ewanna',
      ),
    ).toBe(true)
    expect(looksLikeColorRemoveRequest('White color eka ain karanna')).toBe(
      true,
    )
    expect(looksLikeColorRemoveRequest('Cloudy black 2k oni')).toBe(false)
  })

  it('does not double qty when thawa quotation matches identify pending', () => {
    const existing = [
      {
        productId: 'shoulder-1',
        name: 'Shoulder Bag',
        color: 'Red',
        qty: 2,
        price: 850,
      },
      {
        productId: 'cloudy-1',
        name: 'Cloudy Shoulder Bag',
        color: 'White',
        qty: 1,
        price: 990,
      },
    ]
    const incoming: ResolvedCartLine[] = [
      {
        productId: 'shoulder-1',
        name: 'Shoulder Bag',
        color: 'Red',
        qty: 2,
        confidence: 1,
      },
      {
        productId: 'cloudy-1',
        name: 'Cloudy Shoulder Bag',
        color: 'White',
        qty: 1,
        confidence: 1,
      },
    ]
    const burst = 'Mata me bag 2k oni. Thawa cloudy white ekak oni'
    expect(
      coerceCartOperation({
        burstText: burst,
        operation: 'set',
        intent: 'quotation',
        existing,
        incoming,
      }),
    ).toBe('set')

    const next = applyCartOperationToPending(existing, incoming, 'set')
    expect(next).toHaveLength(2)
    expect(next.find((l) => l.productId === 'shoulder-1')?.qty).toBe(2)
    expect(next.find((l) => l.productId === 'cloudy-1')?.qty).toBe(1)
  })

  it('still adds when thawa only names a new bag not already pending', () => {
    expect(
      coerceCartOperation({
        burstText: 'Thawa cloudy white ekak oni',
        operation: 'set',
        intent: 'quotation',
        existing: [
          {
            productId: 'shoulder-1',
            name: 'Shoulder Bag',
            color: 'Red',
            qty: 2,
            price: 850,
          },
        ],
        incoming: [
          {
            productId: 'cloudy-1',
            name: 'Cloudy Shoulder Bag',
            color: 'White',
            qty: 1,
            confidence: 1,
          },
        ],
      }),
    ).toBe('add')
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

describe('color swap brown→white', () => {
  it('parses Singlish want + remove colors', () => {
    const swap = parseColorSwapRequest(
      'Mata white color eken oni. Meke brown color eka ain karanna',
    )
    expect(swap?.want.toLowerCase()).toBe('white')
    expect(swap?.remove.toLowerCase()).toBe('brown')
  })

  it('recolors brown lines to white and keeps other bags', () => {
    const next = applyColorSwapToPending(
      [
        {
          productId: 'bloom-1',
          name: 'Bloom',
          color: 'White',
          qty: 2,
          price: 1000,
        },
        {
          productId: 'cloudy-1',
          name: 'Cloudy',
          color: 'Brown',
          qty: 1,
          price: 990,
        },
      ],
      { want: 'White', remove: 'Brown' },
    )
    expect(next).toHaveLength(2)
    expect(next.find((l) => l.productId === 'bloom-1')?.qty).toBe(2)
    expect(next.find((l) => l.productId === 'cloudy-1')?.color).toBe('White')
    expect(next.find((l) => l.productId === 'cloudy-1')?.qty).toBe(1)
  })
})
