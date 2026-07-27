'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Loader2, Minus, Plus, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { CatalogProduct } from '@/lib/catalog/products'
import {
  catalogImageForColor,
  toPickedLine,
} from '@/lib/orders/catalog-helpers'
import type { OrderLineItem } from '@/lib/orders/constants'
import {
  loadOrderPickerProducts,
  peekOrderPickerProducts,
} from '@/lib/orders/picker-catalog-cache'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface OrderProductPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: OrderLineItem) => void
  title?: string
  addLabel?: string
}

/**
 * Tampermonkey-style product picker: image grid → color thumbs (same order as
 * colors / quick-reply images) → qty. Double-click a color to add qty 1.
 */
export function OrderProductPicker({
  open,
  onOpenChange,
  onPick,
  title,
  addLabel,
}: OrderProductPickerProps) {
  const t = useTranslations('Inbox.orders')
  const [products, setProducts] = useState<CatalogProduct[]>(
    () => peekOrderPickerProducts() ?? [],
  )
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CatalogProduct | null>(null)
  const [color, setColor] = useState('')
  const [qty, setQty] = useState(1)

  const load = useCallback(async () => {
    const cached = peekOrderPickerProducts()
    if (cached?.length) {
      setProducts(cached)
      setLoading(false)
      // Refresh in background if still within TTL this is a no-op; otherwise updates cache.
      void loadOrderPickerProducts().then(setProducts).catch(() => {})
      return
    }

    setLoading(true)
    try {
      const list = await loadOrderPickerProducts()
      setProducts(list)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('catalogLoadFailed'))
      setProducts([])
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(null)
    setColor('')
    setQty(1)
    void load()
  }, [open, load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter((p) => p.name.toLowerCase().includes(q))
  }, [products, query])

  const pickProduct = (p: CatalogProduct) => {
    setSelected(p)
    setColor(p.colors[0] || '')
    setQty(1)
  }

  const confirm = (product: CatalogProduct, chosenColor: string, chosenQty: number) => {
    onPick(toPickedLine(product, chosenColor, chosenQty))
    onOpenChange(false)
  }

  const confirmSelected = () => {
    if (!selected) return
    const chosenColor = color || selected.colors[0] || ''
    confirm(selected, chosenColor, qty)
  }

  const colors = selected
    ? selected.colors.length
      ? selected.colors
      : ['']
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-3 overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title || t('addProduct')}</DialogTitle>
        </DialogHeader>

        {!selected ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              {t('pickerProductHint')}
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchProducts')}
                className="pl-8"
                autoFocus
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('loadingCatalog')}
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {t('noProducts')}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {filtered.map((p) => {
                    const thumb = p.images[0] || ''
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => pickProduct(p)}
                        className="flex flex-col items-center gap-1 rounded-lg border border-transparent bg-muted/40 p-2 text-center transition-colors hover:border-border hover:bg-muted"
                      >
                        <span className="aspect-square w-full overflow-hidden rounded-md bg-background">
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={thumb}
                              alt=""
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-2 w-full text-[11px] font-semibold leading-snug">
                          {p.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          LKR {(Number(p.price) || 0).toLocaleString('en-LK')}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <div className="flex items-start gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 shrink-0 px-2"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                {t('back')}
              </Button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{selected.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {t('pickerColorHint')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {colors.map((c, idx) => {
                const thumb = catalogImageForColor(selected, c || selected.colors[0] || '')
                const isSelected = (c || '') === (color || '')
                const label = c || selected.name
                return (
                  <button
                    key={`${c || 'default'}-${idx}`}
                    type="button"
                    title={t('doubleClickColorHint')}
                    onClick={() => setColor(c)}
                    onDoubleClick={() => {
                      if (!selected) return
                      confirm(selected, c, 1)
                    }}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-lg border-2 bg-muted/40 p-2 text-center transition-colors',
                      isSelected
                        ? 'border-[#8B4557] bg-muted'
                        : 'border-transparent hover:border-border hover:bg-muted',
                    )}
                  >
                    <span className="aspect-square w-full overflow-hidden rounded-md bg-background">
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb}
                          alt={label}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 w-full text-[11px] font-semibold leading-snug">
                      {label}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t('quantity')}
              </span>
              <div className="flex items-center rounded-lg border border-border">
                <button
                  type="button"
                  aria-label={t('decreaseQty')}
                  disabled={qty <= 1}
                  onClick={() => setQty((q) => Math.max(1, q - 1))}
                  className="flex h-10 w-10 items-center justify-center text-foreground disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <Input
                  id="order-picker-qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  value={qty}
                  onChange={(e) =>
                    setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))
                  }
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    confirmSelected()
                  }}
                  className="h-10 w-12 border-0 bg-transparent px-0 text-center shadow-none focus-visible:ring-0"
                />
                <button
                  type="button"
                  aria-label={t('increaseQty')}
                  disabled={qty >= 99}
                  onClick={() => setQty((q) => Math.min(99, q + 1))}
                  className="flex h-10 w-10 items-center justify-center text-foreground disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              <Button
                type="button"
                size="sm"
                className="ml-auto h-10"
                onClick={confirmSelected}
              >
                {addLabel || t('addToOrder')}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
