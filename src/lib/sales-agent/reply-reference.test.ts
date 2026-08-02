import { describe, expect, it } from 'vitest'
import { parseProductColorFromSummary } from './reply-reference'

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
