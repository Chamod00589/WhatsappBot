import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { fetchOrderPickerProducts } from '@/lib/catalog/products'

/**
 * GET /api/orders/catalog
 * Fast product list for Create Order / Quotation pickers (cached server-side).
 */
export async function GET() {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const products = await fetchOrderPickerProducts()
    return NextResponse.json(
      { success: true, products },
      {
        headers: {
          // Browser / CDN can reuse briefly; server also keeps a 5 min memory cache.
          'Cache-Control': 'private, max-age=60, stale-while-revalidate=240',
        },
      },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Catalog fetch failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
