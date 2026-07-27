'use client'

import {
  formatLkr,
  QUOTATION_SHIPPING_LKR,
  type OrderLineItem,
} from '@/lib/orders/constants'
import { proxiedImageUrl } from '@/lib/orders/catalog-helpers'
import { cn } from '@/lib/utils'

interface QuotationCardProps {
  items: OrderLineItem[]
  className?: string
  emptyLabel?: string
}

export function QuotationCard({
  items,
  className,
  emptyLabel = 'Add products to preview quotation',
}: QuotationCardProps) {
  const itemsSubtotal = items.reduce(
    (sum, it) => sum + (Number(it.price) || 0) * Math.max(1, Number(it.qty) || 1),
    0,
  )
  const grand = itemsSubtotal + QUOTATION_SHIPPING_LKR

  return (
    <div
      className={cn(
        'w-[360px] rounded-lg border border-[#2a3942] bg-[#182229] p-3 font-sans text-[13px] text-[#e9edef]',
        className,
      )}
    >
      {!items.length ? (
        <div className="px-2 py-5 text-center text-[12px] text-[#8696a0]">
          {emptyLabel}
        </div>
      ) : (
        <>
          <div className="mb-2.5 text-center text-[15px] font-bold">
            Price Quotation
          </div>
          <div className="mb-2.5 flex flex-col gap-2">
            {items.map((item, idx) => {
              const qty = Math.max(1, Number(item.qty) || 1)
              const price = Number(item.price) || 0
              const line = qty * price
              const img = proxiedImageUrl(item.image)
              return (
                <div
                  key={idx}
                  className="flex items-center gap-2.5 rounded-lg border border-[#2a3942] bg-[#111b21] p-2"
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
                    <div className="font-semibold leading-snug">
                      {item.name}
                      {item.color ? ` (${item.color})` : ''}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#8696a0]">
                      Qty {qty} × {formatLkr(price)}
                    </div>
                  </div>
                  <div className="shrink-0 whitespace-nowrap font-bold">
                    {formatLkr(line)}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="border-t border-[#2a3942] pt-2">
            <Row label="Items" amount={itemsSubtotal} />
            <Row label="Shipping" amount={QUOTATION_SHIPPING_LKR} />
            <Row label="Total" amount={grand} grand />
          </div>
        </>
      )}
    </div>
  )
}

function Row({
  label,
  amount,
  grand,
}: {
  label: string
  amount: number
  grand?: boolean
}) {
  return (
    <div
      className={cn(
        'flex justify-between gap-3 py-0.5 text-[12px] text-[#cfd7db]',
        grand &&
          'mt-1 border-t border-dashed border-[#3a4a52] pt-1.5 text-[15px] font-bold text-[#e9edef]',
      )}
    >
      <span>{label}</span>
      <span>{formatLkr(amount)}</span>
    </div>
  )
}
