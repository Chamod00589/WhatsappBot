import {
  formatLkr,
  formatOrderLabelBarcode,
  type OrderLineItem,
} from '@/lib/orders/constants'
import { catalogBaseUrl } from '@/lib/catalog/products'
import { CONTEXT_BLURBS } from './types'

/**
 * Server-side order confirm text (replaces browser OrderCard screenshot for MVP).
 */
export function buildServerOrderConfirmText(args: {
  order: {
    id?: string
    customer_name?: string | null
    address?: string | null
    phone?: string | null
    phone2?: string | null
    total_amount?: number | string | null
    shipping_cost?: number | string | null
    items?: Array<{
      name?: string
      color?: string | null
      quantity?: number
      price?: number
    }> | null
  }
  lineItems?: OrderLineItem[]
  useSinglish: boolean
}): { text: string; contextSummary: string } {
  const { order, lineItems, useSinglish } = args
  const total = Math.round(Number(order.total_amount) || 0)
  const shipping = Math.round(Number(order.shipping_cost) || 0)
  const trackId = formatOrderLabelBarcode(order.id)
  const trackUrl = `${catalogBaseUrl().replace(/\/$/, '')}/tracking/${encodeURIComponent(trackId)}`

  const lines: string[] = []
  lines.push(useSinglish ? '*Order confirm*' : '*Order confirmation*')
  lines.push('')

  const items =
    lineItems && lineItems.length > 0
      ? lineItems.map((i) => ({
          name: i.name,
          color: i.color,
          quantity: i.qty,
          price: i.price,
        }))
      : (order.items ?? []).map((i) => ({
          name: i.name || 'Item',
          color: i.color ?? null,
          quantity: i.quantity || 1,
          price: i.price || 0,
        }))

  for (const it of items) {
    const color = it.color ? ` (${it.color})` : ''
    lines.push(
      `• ${it.name}${color} x${it.quantity} — ${formatLkr(Number(it.price) * Number(it.quantity))}`,
    )
  }

  if (shipping > 0) lines.push(`Shipping: ${formatLkr(shipping)}`)
  lines.push(`Total: ${formatLkr(total)}`)
  lines.push('')
  if (order.customer_name) lines.push(`Name: ${order.customer_name}`)
  if (order.address) lines.push(`Address: ${order.address}`)
  const phones = [order.phone, order.phone2].filter(Boolean).join(' / ')
  if (phones) lines.push(`Phone: ${phones}`)
  lines.push('')
  lines.push(`Tracking: ${trackUrl}`)
  lines.push('')
  lines.push(
    useSinglish
      ? 'Order details hari neda? (bag color + address) — hari nam "ok" kiyanna.'
      : 'Are the order details correct (bag color + address)? Reply "ok" to confirm.',
  )

  return {
    text: lines.join('\n'),
    contextSummary: CONTEXT_BLURBS.orderConfirm,
  }
}
