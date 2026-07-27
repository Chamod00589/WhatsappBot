import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  catalogBaseUrl,
  fetchCatalogQuickMessages,
  stubTitleForCatalogMessage,
} from '@/lib/catalog/products'

/**
 * Import / sync ALL admin quick messages from ladiesbags.lk
 * (products + custom) as lightweight stubs with badge colors.
 * Query ?prune=1 removes stubs whose catalog id is gone from admin.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const url = new URL(request.url)
  const prune = url.searchParams.get('prune') === '1'

  let messages
  try {
    messages = await fetchCatalogQuickMessages()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Catalog fetch failed'
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const db = supabaseAdmin()
  let created = 0
  let updated = 0

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const title = stubTitleForCatalogMessage(msg)
    const badge_color = msg.badgeColor || '#00a884'
    // Prefer admin sort_order; fall back to list index (1-based).
    const sort_order = msg.sortOrder > 0 ? msg.sortOrder : i + 1

    const { data: byCatalog } = await db
      .from('quick_replies')
      .select('id, title, badge_color, kind, product_id, sort_order')
      .eq('account_id', ctx.accountId)
      .eq('catalog_message_id', msg.id)
      .maybeSingle()

    let row = byCatalog
    if (!row && msg.productId) {
      const { data: byProduct } = await db
        .from('quick_replies')
        .select('id, title, badge_color, kind, product_id, sort_order')
        .eq('account_id', ctx.accountId)
        .eq('product_id', msg.productId)
        .in('kind', ['product', 'catalog'])
        .maybeSingle()
      row = byProduct
    }

    if (row) {
      const needsUpdate =
        row.title !== title ||
        row.badge_color !== badge_color ||
        row.kind !== 'catalog' ||
        row.product_id !== msg.productId ||
        Number(row.sort_order) !== sort_order

      if (needsUpdate) {
        const { error } = await db
          .from('quick_replies')
          .update({
            title,
            kind: 'catalog',
            catalog_message_id: msg.id,
            badge_color,
            product_id: msg.productId,
            sort_order,
            content_text: null,
            interactive_payload: null,
          })
          .eq('id', row.id)
          .eq('account_id', ctx.accountId)
        if (error) {
          const hint =
            /badge_color|catalog_message_id|product_id|sort_order|schema cache/i.test(
              error.message,
            )
              ? ' Run pending WhatsappBot supabase migrations (040_quick_replies_sort_order.sql), then click Import again.'
              : ''
          return NextResponse.json(
            { error: error.message + hint },
            { status: 500 },
          )
        }
        updated += 1
      }
      continue
    }

    const { error } = await db.from('quick_replies').insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      title,
      kind: 'catalog',
      catalog_message_id: msg.id,
      badge_color,
      product_id: msg.productId,
      sort_order,
      content_text: null,
      interactive_payload: null,
    })
    if (error) {
      const hint =
        /badge_color|catalog_message_id|product_id|sort_order|schema cache/i.test(
          error.message,
        )
          ? ' Run pending WhatsappBot supabase migrations (040_quick_replies_sort_order.sql), then click Import again.'
          : ''
      return NextResponse.json(
        { error: error.message + hint },
        { status: 500 },
      )
    }
    created += 1
  }

  let pruned = 0
  if (prune) {
    const catalogIds = new Set(messages.map((m) => m.id))
    const { data: stubs } = await db
      .from('quick_replies')
      .select('id, catalog_message_id')
      .eq('account_id', ctx.accountId)
      .eq('kind', 'catalog')

    const orphanIds = (stubs ?? [])
      .filter((s) => s.catalog_message_id && !catalogIds.has(s.catalog_message_id))
      .map((s) => s.id)

    if (orphanIds.length) {
      const { error } = await db
        .from('quick_replies')
        .delete()
        .eq('account_id', ctx.accountId)
        .in('id', orphanIds)
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      pruned = orphanIds.length
    }
  }

  return NextResponse.json({
    ok: true,
    catalog: catalogBaseUrl(),
    messages: messages.length,
    products: messages.filter((m) => m.productId).length,
    custom: messages.filter((m) => !m.productId).length,
    jpegReady: messages.filter((m) => m.jpegReady).length,
    created,
    updated,
    pruned,
  })
}
