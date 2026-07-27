'use client'

import {
  formatOrderLabelBarcode,
  formatOrderMoney,
  ORDER_STATUS_LABELS,
  orderShippingShortLabel,
} from '@/lib/orders/constants'
import { proxiedImageUrl } from '@/lib/orders/catalog-helpers'
import { cn } from '@/lib/utils'

export interface LadiesbagsOrderItem {
  name?: string
  color?: string
  price?: number | string
  quantity?: number | string
  productId?: string
  image?: string
}

export interface LadiesbagsOrder {
  id?: string
  created_at?: string
  order_status?: string
  sale_type?: string
  shipping_method?: string
  full_name?: string
  address?: string
  mobile_1?: string
  mobile_2?: string
  whatsapp_phone?: string
  city?: string
  items?: LadiesbagsOrderItem[]
  courier_charge?: number | string
  total_amount?: number | string
  amount_paid?: number | string
  tracking_number?: string
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

interface OrderCardProps {
  order: LadiesbagsOrder
  className?: string
  /** When true, force light-on-dark capture styling (offscreen / preview). */
  capture?: boolean
}

/**
 * Order confirmation card — React DOM (not HTML strings) for html-to-image.
 */
export function OrderCard({ order, className, capture }: OrderCardProps) {
  const items = Array.isArray(order.items) ? order.items : []
  const itemsTotal = items.reduce(
    (sum, it) => sum + num(it.price) * num(it.quantity),
    0,
  )
  const courierCharge = num(order.courier_charge)
  const totalAmount = num(order.total_amount)
  const amountPaid = num(order.amount_paid)
  const remaining = Math.max(0, totalAmount - amountPaid)
  const showPayment =
    order.order_status === 'half_payment' ||
    order.order_status === 'full_payment' ||
    amountPaid > 0
  const statusLabel =
    ORDER_STATUS_LABELS[order.order_status || ''] ||
    String(order.order_status || '').replace(/_/g, ' ')
  const shipLabel = orderShippingShortLabel(order.shipping_method)
  const labelId = formatOrderLabelBarcode(order.id)
  const created = order.created_at
    ? new Date(order.created_at).toLocaleString()
    : ''

  return (
    <div
      className={cn(
        'w-[360px] rounded-lg border border-[#2a3942] bg-[#182229] p-2 font-sans text-[13px] text-[#e9edef]',
        className,
      )}
      data-capture={capture ? '1' : undefined}
    >
      <div className="mb-2.5">
        <div className="font-mono text-[11px] text-[#8696a0]">{labelId}</div>
        {created ? (
          <div className="mt-0.5 text-[11px] text-[#8696a0]">{created}</div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[10px]">
            {statusLabel}
          </span>
          <span className="rounded-full bg-[#2a3942] px-2 py-0.5 text-[10px]">
            {order.sale_type === 'wholesale' ? 'Wholesale' : 'Retail'}
          </span>
          <span className="rounded-full bg-amber-950 px-2 py-0.5 text-[10px] text-amber-300">
            {shipLabel}
          </span>
        </div>
      </div>

      <div className="grid gap-3">
        <section>
          <h4 className="mb-1.5 text-[12px] uppercase tracking-wide text-[#8696a0]">
            Customer
          </h4>
          <p className="mb-1.5 font-semibold">{order.full_name || '—'}</p>
          {(order.address || '')
            .split('\n')
            .filter(Boolean)
            .map((line, i) => (
              <p key={i} className="mb-1 text-[13px] text-[#cfd7db]">
                {i === 0 ? `📍 ${line}` : line}
              </p>
            ))}
          {order.mobile_1 ? (
            <p className="mb-1 text-[13px] text-[#cfd7db]">📞 {order.mobile_1}</p>
          ) : null}
          {order.mobile_2 ? (
            <p className="mb-1 text-[13px] text-[#cfd7db]">📞 {order.mobile_2}</p>
          ) : null}
          {order.whatsapp_phone &&
          order.whatsapp_phone !== order.mobile_1 ? (
            <p className="mb-1 text-[13px] text-[#8696a0]">
              💬 WA chat {order.whatsapp_phone}
            </p>
          ) : null}
          {order.city ? (
            <p className="mb-1 text-[13px] text-[#cfd7db]">🏙 {order.city}</p>
          ) : null}
        </section>

        <section>
          <h4 className="mb-1.5 text-[12px] uppercase tracking-wide text-[#8696a0]">
            Items
          </h4>
          <div className="flex flex-col gap-2">
            {items.length === 0 ? (
              <div className="text-[12px] text-[#8696a0]">No items</div>
            ) : (
              items.map((it, idx) => {
                const qty = num(it.quantity)
                const price = num(it.price)
                const lineTotal = qty * price
                const img = proxiedImageUrl(it.image)
                return (
                  <div
                    key={idx}
                    className="flex items-center gap-2.5 rounded-lg border border-[#2a3942] bg-[#111b21] p-2 text-[12px]"
                  >
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#0b141a]">
                      {img ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={img}
                          alt=""
                          className="h-full w-full object-cover"
                          crossOrigin="anonymous"
                        />
                      ) : (
                        <span className="text-[11px] text-[#54656f]">—</span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold leading-snug text-[#e9edef]">
                        {it.name || 'Item'}
                        {it.color ? ` (${it.color})` : ''}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#8696a0]">
                        Qty {qty} × {formatOrderMoney(price)}
                      </div>
                    </div>
                    <div className="shrink-0 whitespace-nowrap font-bold text-[#e9edef]">
                      {formatOrderMoney(lineTotal)}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="mt-2 border-t border-[#2a3942] pt-2">
            <TotalRow muted label="Items" amount={itemsTotal} />
            <TotalRow muted label={shipLabel} amount={courierCharge} />
            {showPayment ? (
              <>
                <TotalRow muted label="Order total" amount={totalAmount} />
                <TotalRow muted label="Paid" amount={amountPaid} />
              </>
            ) : null}
            <TotalRow
              strong
              label="Total"
              amount={showPayment ? remaining : totalAmount}
            />
            {order.tracking_number ? (
              <div className="mt-1.5 text-[12px]">
                <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[10px] text-amber-300">
                  {shipLabel}
                </span>{' '}
                <span className="font-mono">{order.tracking_number}</span>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}

function TotalRow({
  label,
  amount,
  muted,
  strong,
}: {
  label: string
  amount: number
  muted?: boolean
  strong?: boolean
}) {
  return (
    <div
      className={cn(
        'mb-1 flex justify-between text-[12px]',
        muted && 'text-[#8696a0]',
        strong && 'text-[13px] font-bold text-[#e9edef]',
      )}
    >
      <span>{label}</span>
      <span>{formatOrderMoney(amount)}</span>
    </div>
  )
}
