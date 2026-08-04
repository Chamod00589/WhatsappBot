import { describe, expect, it } from 'vitest'
import {
  extractEditColor,
  isAddToOrderRequest,
  isMostlyColorAsk,
  isOrderEditRequest,
  mergeOrderItemsAdd,
  mergePendingItemsAdd,
} from './order-edit-intent'
import { matchCustomQuickReplies, type CustomQuickReply } from './match-custom-qr'
import {
  extractColorsFromText,
  mergeRequestedItems,
  patchRequestedItemsColor,
} from './order-intent'

describe('order-edit-intent', () => {
  it('detects color change asks', () => {
    expect(isOrderEditRequest('bag eka white karanna')).toBe(true)
    expect(isOrderEditRequest('color eka white venas karanna')).toBe(true)
    expect(isOrderEditRequest('white eka denna')).toBe(true)
    expect(extractEditColor('bag eka white karanna')).toBe('White')
  })

  it('detects Singlish color change (rathu pata)', () => {
    expect(isOrderEditRequest('mata rathu pata bag eka denna')).toBe(true)
    expect(extractEditColor('mata rathu pata bag eka denna')).toBe('Red')
    expect(extractColorsFromText('sudu color eka denna')).toEqual(['White'])
  })

  it('does not treat price asks as edits', () => {
    expect(isOrderEditRequest('bloom black bag price kohomda')).toBe(false)
  })

  it('detects add-another-bag asks', () => {
    expect(
      isAddToOrderRequest(
        'Mata mekata mini sholder white bag ekakuth add karaganna oni',
      ),
    ).toBe(true)
    expect(isAddToOrderRequest('thawa bunny bag ekak add karanna')).toBe(true)
    expect(
      isAddToOrderRequest(
        'White color eka epa. Eka ain karala brown 3k ekathukaranna',
      ),
    ).toBe(true)
    expect(isAddToOrderRequest('price kohomada')).toBe(false)
  })

  it('merges added bags onto existing order lines without dropping them', () => {
    const merged = mergeOrderItemsAdd(
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Brown',
          quantity: 2,
          price: 2500,
        },
      ],
      [
        {
          productId: 'mini',
          name: 'Mini Shoulder Bag',
          color: 'White',
          quantity: 1,
          price: 1800,
        },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged.map((i) => i.name).sort()).toEqual([
      'Cloudy Shoulder Bag',
      'Mini Shoulder Bag',
    ])
    expect(
      merged.find((i) => i.name === 'Cloudy Shoulder Bag')?.quantity,
    ).toBe(2)
    expect(
      merged.find((i) => i.name === 'Mini Shoulder Bag')?.color,
    ).toBe('White')
  })

  it('sums qty when adding the same product+color again', () => {
    const merged = mergeOrderItemsAdd(
      [
        {
          productId: 'mini',
          name: 'Mini Shoulder Bag',
          color: 'White',
          quantity: 1,
          price: 1800,
        },
      ],
      [
        {
          productId: 'mini',
          name: 'Mini Shoulder Bag',
          color: 'White',
          quantity: 1,
          price: 1800,
        },
      ],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].quantity).toBe(2)
  })

  it('merges pending quotation lines when adding a bag pre-order', () => {
    const merged = mergePendingItemsAdd(
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Brown',
          qty: 2,
          price: 2500,
        },
      ],
      [
        {
          productId: 'mini',
          name: 'Mini Shoulder Bag',
          color: 'White',
          qty: 1,
          price: 1800,
        },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((i) => i.name.includes('Cloudy'))?.qty).toBe(2)
    expect(merged.find((i) => i.name.includes('Mini'))?.color).toBe('White')
  })

  it('keeps White and adds Black as separate quotation lines', () => {
    const merged = mergePendingItemsAdd(
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'White',
          qty: 1,
          price: 2500,
        },
      ],
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Black',
          qty: 2,
          price: 2500,
        },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((i) => i.color === 'White')?.qty).toBe(1)
    expect(merged.find((i) => i.color === 'Black')?.qty).toBe(2)
  })

  it('detects dekakuth as add-to-order', () => {
    expect(isAddToOrderRequest('Mata me color bag dekakuth denna')).toBe(true)
  })
})

describe('requested items memory', () => {
  it('keeps separate colors when merging pending bags', () => {
    const merged = mergeRequestedItems(
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Black',
          qty: 2,
          price: 2500,
        },
      ],
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Red',
          qty: 2,
          price: 2500,
        },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged.map((i) => i.color).sort()).toEqual(['Black', 'Red'])
  })

  it('colorless find_product touch keeps prior color', () => {
    const merged = mergeRequestedItems(
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'White',
          qty: 1,
          price: 2500,
        },
      ],
      [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: '',
          qty: 1,
          price: 2500,
        },
      ],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].color).toBe('White')
  })

  it('patches color and keeps qty', () => {
    const patched = patchRequestedItemsColor(
      [
        {
          name: 'Cloudy Shoulder Bag',
          color: 'Black',
          qty: 2,
          price: 2500,
        },
      ],
      'Red',
    )
    expect(patched[0].color).toBe('Red')
    expect(patched[0].qty).toBe(2)
  })
})

describe('matchCustomQuickReplies description matching', () => {
  const whiteBags: CustomQuickReply = {
    id: '1',
    title: 'White bags Quick Reply',
    description: 'Shows all white color bags available in the shop',
    kind: 'catalog',
    content_text: null,
    catalog_message_id: 'qm_white',
    product_id: null,
  }

  it('does not match White bags FAQ for color-edit asks', () => {
    expect(
      matchCustomQuickReplies('mata rathu pata bag eka denna', [whiteBags]),
    ).toEqual([])
    expect(isMostlyColorAsk('mata rathu pata bag eka denna')).toBe(true)
  })
})
