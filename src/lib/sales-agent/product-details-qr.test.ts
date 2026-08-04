import { describe, expect, it } from 'vitest'
import {
  isProductDetailsOrColorsAsk,
  resolveProductForDetailsAsk,
} from './product-details-qr'
import { buildProductNeedles, type MatchableQuickReply } from './match-products'

function cloudyCatalog(): MatchableQuickReply[] {
  return [
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
    },
  ]
}

describe('isProductDetailsOrColorsAsk', () => {
  it('detects Singlish colors ask for me bag', () => {
    expect(
      isProductDetailsOrColorsAsk('Me bag eke thawa monawda colors thiyenne'),
    ).toBe(true)
  })

  it('does not treat price ask as details ask', () => {
    expect(isProductDetailsOrColorsAsk('Cloudy brown bag dekak oni')).toBe(
      false,
    )
    expect(isProductDetailsOrColorsAsk('kochchara da price')).toBe(false)
  })
})

describe('resolveProductForDetailsAsk', () => {
  it('uses pending quotation bag for me bag colors ask', () => {
    const hit = resolveProductForDetailsAsk({
      burstText: 'Me bag eke thawa monawda colors thiyenne',
      orderPending: {
        type: 'awaiting_address',
        items: [
          {
            productId: 'cloudy-1',
            name: 'Cloudy Shoulder Bag',
            color: 'Brown',
            qty: 2,
            price: 2500,
          },
        ],
        askedAt: new Date().toISOString(),
      },
      productCatalog: cloudyCatalog(),
    })
    expect(hit?.product_id).toBe('cloudy-1')
    expect(hit?.catalog_message_id).toBe('qm_site_prod_cloudy-1')
  })
})
