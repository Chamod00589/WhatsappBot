import { describe, expect, it } from 'vitest'
import { verifyCartChangeDeterministic } from './cart-change-verify'

describe('verifyCartChangeDeterministic', () => {
  it('rejects exact qty doubling without double language', () => {
    const r = verifyCartChangeDeterministic({
      oldItems: [
        { productId: 'a', name: 'Shoulder Bag', color: 'Red', qty: 2 },
        { productId: 'b', name: 'Cloudy', color: 'White', qty: 1 },
      ],
      newItems: [
        { productId: 'a', name: 'Shoulder Bag', color: 'Red', qty: 4 },
        { productId: 'b', name: 'Cloudy', color: 'White', qty: 2 },
      ],
      customerText: 'Mata me bag 2k oni. Thawa cloudy white ekak oni',
      operation: 'set',
    })
    expect(r?.ok).toBe(false)
    expect(r && !r.ok && r.reason).toBe('qty_doubled')
  })

  it('rejects color swap that leaves remove color', () => {
    const r = verifyCartChangeDeterministic({
      oldItems: [
        { productId: 'b', name: 'Cloudy', color: 'Brown', qty: 1 },
        { productId: 'a', name: 'Bloom', color: 'White', qty: 2 },
      ],
      newItems: [
        { productId: 'b', name: 'Cloudy', color: 'Brown', qty: 1 },
        { productId: 'a', name: 'Bloom', color: 'White', qty: 2 },
      ],
      customerText:
        'Mata white color eken oni. Meke brown color eka ain karanna',
      operation: 'set',
    })
    expect(r?.ok).toBe(false)
    expect(r && !r.ok && r.reason).toBe('color_swap_remove_left')
  })

  it('passes a correct brown→white swap', () => {
    const r = verifyCartChangeDeterministic({
      oldItems: [
        { productId: 'b', name: 'Cloudy', color: 'Brown', qty: 1 },
        { productId: 'a', name: 'Bloom', color: 'White', qty: 2 },
      ],
      newItems: [
        { productId: 'b', name: 'Cloudy', color: 'White', qty: 1 },
        { productId: 'a', name: 'Bloom', color: 'White', qty: 2 },
      ],
      customerText:
        'Mata white color eken oni. Meke brown color eka ain karanna',
      operation: 'set',
    })
    expect(r).toBeNull()
  })

  it('rejects invented bag on add without naming it', () => {
    const r = verifyCartChangeDeterministic({
      oldItems: [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Black',
          qty: 1,
        },
      ],
      newItems: [
        {
          productId: 'cloudy',
          name: 'Cloudy Shoulder Bag',
          color: 'Black',
          qty: 1,
        },
        { productId: 'tape', name: 'Tape Bag', color: 'Black', qty: 1 },
      ],
      customerText: 'Thawa white bag ekakuth',
      operation: 'add',
    })
    expect(r?.ok).toBe(false)
    expect(r && !r.ok && r.reason).toBe('invented_bag')
  })

  it('skips when old cart empty', () => {
    const r = verifyCartChangeDeterministic({
      oldItems: [],
      newItems: [
        { productId: 'a', name: 'Shoulder Bag', color: 'Red', qty: 2 },
      ],
      customerText: 'Mata me bag 2k oni',
      operation: 'set',
    })
    expect(r).toBeNull()
  })
})
