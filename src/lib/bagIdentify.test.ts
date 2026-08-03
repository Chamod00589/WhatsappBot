import { describe, expect, it } from 'vitest'
import {
  colorFromIdentifyImagePath,
  normalizeBagMatch,
  normalizeIdentifyColorLabel,
} from '@/lib/bagIdentify'

describe('normalizeIdentifyColorLabel', () => {
  it('keeps plain color names', () => {
    expect(normalizeIdentifyColorLabel('Pink')).toBe('Pink')
    expect(normalizeIdentifyColorLabel('Brownish Pink')).toBe('Brownish Pink')
  })

  it('strips same-color variants after __', () => {
    expect(normalizeIdentifyColorLabel('Pink__2')).toBe('Pink')
    expect(normalizeIdentifyColorLabel('Pink__side')).toBe('Pink')
    expect(normalizeIdentifyColorLabel('Brownish Pink__3')).toBe('Brownish Pink')
  })

  it('treats _* stems as product-only (no color)', () => {
    expect(normalizeIdentifyColorLabel('_1')).toBe('')
    expect(normalizeIdentifyColorLabel('_all')).toBe('')
    expect(normalizeIdentifyColorLabel('_group')).toBe('')
    expect(normalizeIdentifyColorLabel('_product')).toBe('')
  })
})

describe('colorFromIdentifyImagePath', () => {
  it('parses flat color + variant files', () => {
    expect(
      colorFromIdentifyImagePath(
        'products-images/Bloom Shoulder Bag/Pink.webp',
      ),
    ).toBe('Pink')
    expect(
      colorFromIdentifyImagePath(
        'products-images/Bloom Shoulder Bag/Pink__2.webp',
      ),
    ).toBe('Pink')
  })

  it('parses nested color folders', () => {
    expect(
      colorFromIdentifyImagePath(
        'products-images/Bloom Shoulder Bag/Pink/01.webp',
      ),
    ).toBe('Pink')
  })

  it('parses product-only shots', () => {
    expect(
      colorFromIdentifyImagePath(
        'products-images/Bloom Shoulder Bag/_1.webp',
      ),
    ).toBe('')
    expect(
      colorFromIdentifyImagePath(
        'products-images/Bloom Shoulder Bag/_/shot.webp',
      ),
    ).toBe('')
  })
})

describe('normalizeBagMatch', () => {
  it('fixes legacy Pink__2 color labels from the Space', () => {
    const m = normalizeBagMatch({
      rank: 1,
      product: 'Bloom Shoulder Bag',
      color: 'Pink__2',
      confidence: 95,
      image_path: 'products-images/Bloom Shoulder Bag/Pink__2.webp',
    })
    expect(m.color).toBe('Pink')
  })

  it('clears _1 color labels', () => {
    const m = normalizeBagMatch({
      rank: 1,
      product: 'Bloom Shoulder Bag',
      color: '_1',
      confidence: 92,
      image_path: 'products-images/Bloom Shoulder Bag/_1.webp',
    })
    expect(m.color).toBe('')
  })
})
