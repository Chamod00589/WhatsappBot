import { describe, expect, it } from 'vitest'
import {
  isCompositeOrderCardSummary,
  parseProductColorFromSummary,
  shouldApplyReplyRefToPending,
} from './reply-reference'
import { CONTEXT_BLURBS } from './types'

describe('parseProductColorFromSummary', () => {
  it('parses identify / find_product context summaries', () => {
    expect(
      parseProductColorFromSummary(
        'Sent product quick reply for Cloudy Shoulder Bag (White) after image identify 100%',
      ),
    ).toEqual({
      productName: 'Cloudy Shoulder Bag',
      color: 'White',
    })
  })

  it('parses short Title (Color) labels', () => {
    expect(parseProductColorFromSummary('Cloudy Shoulder Bag (Brown)')).toEqual(
      {
        productName: 'Cloudy Shoulder Bag',
        color: 'Brown',
      },
    )
  })
})

describe('composite order cards', () => {
  it('treats order confirm / quotation blurbs as non-product refs', () => {
    expect(isCompositeOrderCardSummary(CONTEXT_BLURBS.orderConfirm)).toBe(true)
    expect(isCompositeOrderCardSummary(CONTEXT_BLURBS.quotation)).toBe(true)
    expect(
      isCompositeOrderCardSummary(
        'Sent product quick reply for Cloudy Shoulder Bag (White)',
      ),
    ).toBe(false)
  })

  it('does not upsert pending on ekath add (avoids qty 2)', () => {
    expect(shouldApplyReplyRefToPending('Me bag ekath denna')).toBe(false)
    expect(shouldApplyReplyRefToPending('me color eken white')).toBe(true)
  })
})
