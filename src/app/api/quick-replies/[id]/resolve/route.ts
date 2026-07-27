import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  catalogBaseUrl,
  fetchCatalogQuickMessage,
} from '@/lib/catalog/products'

/**
 * Resolve a catalog/product quick-reply stub into live caption + image URLs.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data: qr, error } = await supabase
      .from('quick_replies')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!qr) {
      return NextResponse.json({ error: 'Quick reply not found' }, { status: 404 })
    }

    const catalogMessageId =
      (typeof qr.catalog_message_id === 'string' && qr.catalog_message_id) ||
      (qr.product_id ? `qm_site_prod_${qr.product_id}` : null)

    if (
      (qr.kind !== 'catalog' && qr.kind !== 'product') ||
      !catalogMessageId
    ) {
      return NextResponse.json(
        { error: 'Not a catalog quick reply' },
        { status: 400 },
      )
    }

    const msg = await fetchCatalogQuickMessage(catalogMessageId)
    if (!msg) {
      return NextResponse.json(
        { error: `Catalog message "${catalogMessageId}" not found` },
        { status: 404 },
      )
    }

    return NextResponse.json({
      quick_reply_id: qr.id,
      catalog: catalogBaseUrl(),
      catalog_message_id: msg.id,
      productId: msg.productId,
      name: msg.title,
      title: qr.title,
      text: msg.text,
      imageUrls: msg.imageUrls,
      jpegReady: msg.jpegReady,
      badgeColor: msg.badgeColor,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
