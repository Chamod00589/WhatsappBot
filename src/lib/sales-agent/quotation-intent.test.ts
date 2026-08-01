import assert from 'node:assert/strict'
import {
  isQuotationRequest,
  qtyPerLine,
} from './quotation-intent'

assert.equal(
  isQuotationRequest('mata me bags 2 ganna oni price kohomada'),
  true,
)
assert.equal(isQuotationRequest('Bloom bag price kiyanna'), true)
assert.equal(isQuotationRequest('evlo price sollu'), true)
assert.equal(isQuotationRequest('Bloom shoulder bag black'), false)
assert.equal(qtyPerLine(2, 2), 1)
assert.equal(qtyPerLine(1, 2), 2)
assert.equal(qtyPerLine(2, 1), 1)

console.log('quotation-intent ok')
