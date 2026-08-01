import { describe, expect, it } from 'vitest'
import { matchCatalogProductByLooseName, type CatalogProduct } from './products'

describe('matchCatalogProductByLooseName', () => {
  const products: CatalogProduct[] = [
    {
      id: 'bloom',
      name: 'Bloom Shoulder Bag',
      price: 2500,
      colors: ['Black', 'Pink'],
      images: [],
    },
    {
      id: 'cloudy',
      name: 'Cloudy Shoulder Bag',
      price: 990,
      colors: ['Black'],
      images: [],
    },
  ]

  it('maps Bloom Bag to Bloom Shoulder Bag', () => {
    expect(matchCatalogProductByLooseName(products, 'Bloom Bag')?.id).toBe(
      'bloom',
    )
  })

  it('maps cloudy black bag style names', () => {
    expect(
      matchCatalogProductByLooseName(products, 'Cloudy Bag')?.name,
    ).toBe('Cloudy Shoulder Bag')
  })
})
