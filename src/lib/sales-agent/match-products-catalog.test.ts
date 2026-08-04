import { describe, expect, it } from 'vitest'
import {
  buildProductNeedles,
  formatProductCatalogLine,
  type MatchableQuickReply,
} from './match-products'

describe('formatProductCatalogLine', () => {
  it('includes bag name, retail price, and colors for the agent prompt', () => {
    const qr: MatchableQuickReply = {
      id: 'qr1',
      title: 'Cloudy Shoulder Bag Details Quick Reply',
      description: null,
      kind: 'catalog',
      product_id: 'cloudy',
      catalog_message_id: 'qm_site_prod_cloudy',
      needles: buildProductNeedles('Cloudy Shoulder Bag', 'cloudy'),
      bagName: 'Cloudy Shoulder Bag',
      retailPrice: 2500,
      colors: ['White', 'Black', 'Pink'],
    }
    const line = formatProductCatalogLine(qr)
    expect(line).toContain('Cloudy Shoulder Bag')
    expect(line).toContain('retail=Rs 2,500')
    expect(line).toContain('colors=White, Black, Pink')
    expect(line).toContain('product=cloudy')
  })
})
