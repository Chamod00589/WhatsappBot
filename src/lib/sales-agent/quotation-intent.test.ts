import { describe, expect, it } from 'vitest'
import {
  assignQtysToImageLines,
  isQuotationRequest,
  qtyPerLine,
} from './quotation-intent'
import { extractAllQtys, extractExplicitQty } from './order-intent'

describe('quotation-intent', () => {
  it('detects price / quotation asks', () => {
    expect(
      isQuotationRequest('mata me bags 2 ganna oni price kohomada'),
    ).toBe(true)
    expect(isQuotationRequest('Bloom bag price kiyanna')).toBe(true)
    expect(isQuotationRequest('evlo price sollu')).toBe(true)
    expect(isQuotationRequest('Bloom shoulder bag black')).toBe(false)
    expect(isQuotationRequest('meka 2k ganna oni')).toBe(true)
  })

  it('qtyPerLine keeps legacy single-qty behaviour', () => {
    expect(qtyPerLine(2, 2)).toBe(1)
    expect(qtyPerLine(1, 2)).toBe(2)
    expect(qtyPerLine(2, 1)).toBe(1)
  })

  it('assigns per-image qty from each caption', () => {
    expect(
      assignQtysToImageLines(2, ['meka 2k ganna', 'meka 3k ganna'], ''),
    ).toEqual([2, 3])
  })

  it('zips multiple Nk mentions onto images when captions lack qty', () => {
    expect(
      assignQtysToImageLines(2, ['', ''], 'meka 2k\nmeka 3k\nprice kohomda'),
    ).toEqual([2, 3])
  })

  it('prefers caption qty and zips remaining from global text', () => {
    expect(
      assignQtysToImageLines(2, ['2k', null], 'also 5k somewhere'),
    ).toEqual([2, 5])
  })

  it('parses explicit qty helpers', () => {
    expect(extractExplicitQty('meka 3k ganna')).toBe(3)
    expect(extractAllQtys('2k ganna\n3k ganna')).toEqual([2, 3])
  })
})
