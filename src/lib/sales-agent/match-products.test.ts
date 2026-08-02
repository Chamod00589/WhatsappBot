import { describe, expect, it } from 'vitest'
import {
  buildProductNeedles,
  matchProductsInText,
  type MatchableQuickReply,
} from './match-products'
import { questionFingerprint, isSameQuestion } from './normalize'
import { stripTestMarker } from './gates'

describe('buildProductNeedles', () => {
  it('extracts bag name tokens', () => {
    const needles = buildProductNeedles('Bunny Bag Details Quick Reply', 'bunny_bag')
    expect(needles.some((n) => n.includes('bunny'))).toBe(true)
  })
})

describe('matchProductsInText', () => {
  const catalog: MatchableQuickReply[] = [
    {
      id: '1',
      title: 'Bunny Bag Details Quick Reply',
      description: null,
      kind: 'catalog',
      product_id: 'bunny',
      catalog_message_id: 'qm_site_prod_bunny',
      needles: buildProductNeedles('Bunny Bag Details Quick Reply', 'bunny'),
    },
    {
      id: '2',
      title: 'Mini Pouch Details Quick Reply',
      description: null,
      kind: 'catalog',
      product_id: 'mini_pouch',
      catalog_message_id: 'qm_site_prod_mini',
      needles: buildProductNeedles('Mini Pouch Details Quick Reply', 'mini_pouch'),
    },
  ]

  it('matches product name in customer text', () => {
    const hits = matchProductsInText('bunny bag price eka kiyanna', catalog)
    expect(hits.map((h) => h.product_id)).toContain('bunny')
  })

  it('matches multiple products', () => {
    const hits = matchProductsInText('bunny and mini pouch both', catalog)
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })
})

describe('dedupe fingerprint', () => {
  it('treats near-duplicate questions as same', () => {
    const a = questionFingerprint('Bunny bag price eka kiyanna')
    const b = questionFingerprint('bunny bag price eka kiyanna please')
    expect(isSameQuestion(a, b)).toBe(true)
  })
})

describe('stripTestMarker', () => {
  it('removes *** from inbound', () => {
    expect(stripTestMarker('*** bunny bag')).toBe('bunny bag')
  })

  it('detects *** reset marker', async () => {
    const { inboundHasTestMarker } = await import('./gates')
    expect(inboundHasTestMarker('***')).toBe(true)
    expect(inboundHasTestMarker('*** cloudy bag')).toBe(true)
    expect(inboundHasTestMarker('cloudy bag')).toBe(false)
  })
})
