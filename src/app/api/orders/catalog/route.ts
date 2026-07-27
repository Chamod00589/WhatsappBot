import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { fetchOrderPickerProducts } from '@/lib/catalog/products'

/**
 * GET /api/orders/catalog
 * Product list for Create Order / Quotation pickers.
 * Uses quick-reply image URLs (color index ↔ image index), enriched from /api/products.
 */
export async function GET() {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const products = await fetchOrderPickerProducts()
    return NextResponse.json({ success: true, products })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Catalog fetch failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
