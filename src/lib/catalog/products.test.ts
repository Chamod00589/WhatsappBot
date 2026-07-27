import { describe, expect, it } from 'vitest'
import {
  isMetaFriendlyImageUrl,
  productQuickReplyTitle,
  stubTitleForCatalogMessage,
} from './products'

describe('productQuickReplyTitle', () => {
  it('appends Details Quick Reply', () => {
    expect(productQuickReplyTitle('Cloudy Shoulder Bag')).toBe(
      'Cloudy Shoulder Bag Details Quick Reply',
    )
  })

  it('does not double-suffix', () => {
    expect(
      productQuickReplyTitle('Cloudy Shoulder Bag Details Quick Reply'),
    ).toBe('Cloudy Shoulder Bag Details Quick Reply')
  })
})

describe('stubTitleForCatalogMessage', () => {
  it('suffixes product titles', () => {
    expect(
      stubTitleForCatalogMessage({
        id: 'qm_site_prod_1',
        title: 'Cloudy Shoulder Bag',
        text: '',
        description: '',
        imageUrls: [],
        jpegReady: true,
        productId: '1',
        sortOrder: 1,
        badgeColor: '#00a884',
      }),
    ).toBe('Cloudy Shoulder Bag Details Quick Reply')
  })

  it('keeps custom titles as-is when already suffixed', () => {
    expect(
      stubTitleForCatalogMessage({
        id: 'qm_site_custom_1',
        title: 'COD info Quick Reply',
        text: 'hello',
        description: 'COD details',
        imageUrls: [],
        jpegReady: false,
        productId: null,
        sortOrder: 2,
        badgeColor: '#64c4ff',
      }),
    ).toBe('COD info Quick Reply')
  })

  it('appends Quick Reply for custom titles', () => {
    expect(
      stubTitleForCatalogMessage({
        id: 'qm_site_custom_1',
        title: 'COD info',
        text: 'hello',
        description: '',
        imageUrls: [],
        jpegReady: false,
        productId: null,
        sortOrder: 2,
        badgeColor: '#64c4ff',
      }),
    ).toBe('COD info Quick Reply')
  })
})

describe('isMetaFriendlyImageUrl', () => {
  it('accepts jpeg/png', () => {
    expect(isMetaFriendlyImageUrl('https://img.example/a.jpg')).toBe(true)
    expect(isMetaFriendlyImageUrl('https://img.example/a.png')).toBe(true)
  })

  it('rejects webp', () => {
    expect(isMetaFriendlyImageUrl('https://img.example/a.webp')).toBe(false)
  })
})
