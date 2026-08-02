import { describe, expect, it } from 'vitest'
import {
  extractEditColor,
  isMostlyColorAsk,
  isOrderEditRequest,
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
})

describe('requested items memory', () => {
  it('merges qty/color updates without dropping the bag', () => {
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
    expect(merged).toHaveLength(1)
    expect(merged[0].color).toBe('Red')
    expect(merged[0].qty).toBe(2)
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
    needles: ['white bags'],
  }

  it('does not match White bags FAQ for color-edit asks', () => {
    expect(
      matchCustomQuickReplies('mata rathu pata bag eka denna', [whiteBags]),
    ).toEqual([])
    expect(isMostlyColorAsk('mata rathu pata bag eka denna')).toBe(true)
  })
})
