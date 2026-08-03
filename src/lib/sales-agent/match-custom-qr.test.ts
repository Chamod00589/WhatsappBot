import { describe, expect, it } from 'vitest'
import {
  findAddressRequestQr,
  findCustomQuickReply,
  matchCustomQuickReplies,
  type CustomQuickReply,
} from './match-custom-qr'
import { isMostlyColorAsk } from './order-edit-intent'

const deliveryQr: CustomQuickReply = {
  id: 'd1',
  title: 'Delivery Quick Reply',
  description: 'Deliver Time and price',
  kind: 'catalog',
  content_text: null,
  catalog_message_id: 'qm_delivery',
  product_id: null,
}

const whiteBags: CustomQuickReply = {
  id: '1',
  title: 'White bags Quick Reply',
  description: 'Shows all white color bags available in the shop',
  kind: 'catalog',
  content_text: null,
  catalog_message_id: 'qm_white',
  product_id: null,
}

describe('findCustomQuickReply (LLM picks id)', () => {
  it('resolves by quick_reply_id', () => {
    expect(
      findCustomQuickReply([deliveryQr, whiteBags], { quickReplyId: 'd1' })
        ?.title,
    ).toBe('Delivery Quick Reply')
  })

  it('resolves by catalog_message_id', () => {
    expect(
      findCustomQuickReply([deliveryQr], {
        catalogMessageId: 'qm_delivery',
      })?.id,
    ).toBe('d1')
  })

  it('returns null when id unknown', () => {
    expect(
      findCustomQuickReply([deliveryQr], { quickReplyId: 'missing' }),
    ).toBeNull()
  })
})

describe('matchCustomQuickReplies (guard only)', () => {
  it('does not match White bags FAQ for color-edit asks', () => {
    expect(
      matchCustomQuickReplies('mata rathu pata bag eka denna', [whiteBags]),
    ).toEqual([])
    expect(isMostlyColorAsk('mata rathu pata bag eka denna')).toBe(true)
  })
})

describe('findAddressRequestQr', () => {
  it('picks Address Quick Reply and skips shop location', () => {
    const address: CustomQuickReply = {
      id: 'a1',
      title: 'Address Quick Reply',
      description: 'Request Address format to place an order',
      kind: 'catalog',
      content_text: null,
      catalog_message_id: 'qm_address',
      product_id: null,
    }
    const shop: CustomQuickReply = {
      id: 's1',
      title: 'Shop Location Quick Reply',
      description: 'Shop Location (address, And other contact info included)',
      kind: 'catalog',
      content_text: null,
      catalog_message_id: 'qm_shop',
      product_id: null,
    }
    expect(
      findAddressRequestQr([deliveryQr, shop, address, whiteBags])?.title,
    ).toBe('Address Quick Reply')
  })
})
