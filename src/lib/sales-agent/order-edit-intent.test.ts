import { describe, expect, it } from 'vitest'
import {
  extractEditColor,
  isMostlyColorAsk,
  isOrderEditRequest,
} from './order-edit-intent'
import { matchCustomQuickReplies, type CustomQuickReply } from './match-custom-qr'

describe('order-edit-intent', () => {
  it('detects color change asks', () => {
    expect(isOrderEditRequest('bag eka white karanna')).toBe(true)
    expect(isOrderEditRequest('color eka white venas karanna')).toBe(true)
    expect(isOrderEditRequest('white eka denna')).toBe(true)
    expect(extractEditColor('bag eka white karanna')).toBe('White')
  })

  it('does not treat price asks as edits', () => {
    expect(isOrderEditRequest('bloom black bag price kohomda')).toBe(false)
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

  const delivery: CustomQuickReply = {
    id: '2',
    title: 'Delivery time Quick Reply',
    description:
      'Explains courier delivery time 2-3 working days and shipping charge',
    kind: 'catalog',
    content_text: null,
    catalog_message_id: 'qm_del',
    product_id: null,
  }

  it('does not match White bags QR for order color-change ask', () => {
    const hits = matchCustomQuickReplies('bag eka white karanna', [
      whiteBags,
      delivery,
    ])
    expect(hits).toHaveLength(0)
  })

  it('matches delivery QR when description fits the question', () => {
    const hits = matchCustomQuickReplies(
      'delivery time kochchara days da?',
      [whiteBags, delivery],
      { minScore: 0.3 },
    )
    expect(hits[0]?.qr.title).toContain('Delivery')
  })

  it('flags mostly color asks', () => {
    expect(isMostlyColorAsk('white')).toBe(true)
    expect(isMostlyColorAsk('delivery time kiyanna')).toBe(false)
  })
})
