'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  Pencil,
  Plus,
  Save,
  Trash2,
  Link2,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  OrderCard,
  type LadiesbagsOrder,
  type LadiesbagsOrderItem,
} from '@/components/inbox/order-card'
import { OrderProductPicker } from '@/components/inbox/order-product-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { catalogBaseUrl } from '@/lib/catalog/products'
import {
  extractPhonesFromOrderText,
  formatLkr,
  formatOrderLabelBarcode,
  normalizeSlMobile10,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_OPTIONS,
  SHIPPING_METHOD_OPTIONS,
  type OrderLineItem,
} from '@/lib/orders/constants'
type EditLine = {
  productId: string
  name: string
  color: string
  qty: number
  price: number
  image?: string
}

interface LatestOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactPhone?: string | null
  /** Live or remembered chat selection — used as fallback phone source. */
  selectionText?: string | null
  onSendText: (text: string) => void | Promise<void>
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function itemToEditLine(it: LadiesbagsOrderItem): EditLine | null {
  const productId = String(it.productId ?? '').trim()
  const name = String(it.name ?? '').trim()
  const color = String(it.color ?? '').trim()
  if (!name || !color) return null
  return {
    productId: productId || name,
    name,
    color,
    qty: Math.max(1, Math.round(num(it.quantity) || 1)),
    price: num(it.price),
    image: typeof it.image === 'string' ? it.image : undefined,
  }
}

function customerTrackingUrl(order: LadiesbagsOrder): string | null {
  const tracking = order.tracking_number?.trim()
  if (!tracking) return null
  const shipping = order.shipping_method || 'courier'
  if (shipping !== 'courier') return null
  const base = catalogBaseUrl().replace(/\/$/, '')
  return `${base}/tracking/${encodeURIComponent(tracking)}`
}

async function fetchOrderByPhone(
  phone: string,
): Promise<LadiesbagsOrder | null> {
  const res = await fetch(
    `/api/orders/by-phone?phone=${encodeURIComponent(phone)}`,
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`,
    )
  }
  return (data?.order as LadiesbagsOrder | null) ?? null
}

export function LatestOrderDialog({
  open,
  onOpenChange,
  contactPhone,
  selectionText,
  onSendText,
}: LatestOrderDialogProps) {
  const t = useTranslations('Inbox.orders')

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sendingLink, setSendingLink] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [order, setOrder] = useState<LadiesbagsOrder | null>(null)
  const [matchedPhone, setMatchedPhone] = useState('')
  const [searchSource, setSearchSource] = useState<'chat' | 'selection' | ''>(
    '',
  )
  const [pickerOpen, setPickerOpen] = useState(false)

  // Edit form
  const [fullName, setFullName] = useState('')
  const [address, setAddress] = useState('')
  const [mobile1, setMobile1] = useState('')
  const [mobile2, setMobile2] = useState('')
  const [whatsappPhone, setWhatsappPhone] = useState('')
  const [city, setCity] = useState('')
  const [status, setStatus] = useState('pending')
  const [shippingMethod, setShippingMethod] = useState('courier')
  const [courierCharge, setCourierCharge] = useState('0')
  const [amountPaid, setAmountPaid] = useState('0')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [saleType, setSaleType] = useState('retail')
  const [paymentMethod, setPaymentMethod] = useState('Cash on Delivery')
  const [adminNotes, setAdminNotes] = useState('')
  const [lines, setLines] = useState<EditLine[]>([])

  const selectionPhones = useMemo(
    () => extractPhonesFromOrderText((selectionText || '').trim()),
    [selectionText],
  )

  const fillEditForm = useCallback((o: LadiesbagsOrder) => {
    setFullName(o.full_name || '')
    setAddress(o.address || '')
    setMobile1(o.mobile_1 || '')
    setMobile2(o.mobile_2 || '')
    setWhatsappPhone(o.whatsapp_phone || '')
    setCity(o.city || '')
    setStatus(o.order_status || 'pending')
    setShippingMethod(o.shipping_method || 'courier')
    setCourierCharge(String(num(o.courier_charge)))
    setAmountPaid(String(num(o.amount_paid)))
    setTrackingNumber(o.tracking_number || '')
    setSaleType(o.sale_type || 'retail')
    setPaymentMethod(o.payment_method || 'Cash on Delivery')
    setAdminNotes(o.admin_notes || '')
    const nextLines = (Array.isArray(o.items) ? o.items : [])
      .map(itemToEditLine)
      .filter((x): x is EditLine => !!x)
    setLines(nextLines)
  }, [])

  const runSearch = useCallback(async () => {
    setLoading(true)
    setError('')
    setOrder(null)
    setMatchedPhone('')
    setSearchSource('')
    setEditing(false)

    const chatPhone = normalizeSlMobile10(contactPhone || '')
    const fallbackPhone = selectionPhones[0] || ''

    try {
      if (chatPhone) {
        const found = await fetchOrderByPhone(chatPhone)
        if (found) {
          setOrder(found)
          setMatchedPhone(chatPhone)
          setSearchSource('chat')
          fillEditForm(found)
          return
        }
      }

      if (fallbackPhone && fallbackPhone !== chatPhone) {
        const found = await fetchOrderByPhone(fallbackPhone)
        if (found) {
          setOrder(found)
          setMatchedPhone(fallbackPhone)
          setSearchSource('selection')
          fillEditForm(found)
          return
        }
      }

      if (!chatPhone && !fallbackPhone) {
        setError(t('latestOrderNoPhone'))
      } else {
        setError(t('latestOrderNotFound'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('latestOrderSearchFailed'))
    } finally {
      setLoading(false)
    }
  }, [contactPhone, selectionPhones, fillEditForm, t])

  useEffect(() => {
    if (!open) return
    void runSearch()
  }, [open, runSearch])

  const itemsTotal = useMemo(
    () => lines.reduce((sum, l) => sum + l.price * l.qty, 0),
    [lines],
  )
  const courierNum = num(courierCharge)
  const grandTotal = itemsTotal + courierNum

  const trackingUrl = order ? customerTrackingUrl(order) : null
  const labelId = order?.id ? formatOrderLabelBarcode(order.id) : ''

  const startEdit = () => {
    if (!order) return
    fillEditForm(order)
    setEditing(true)
  }

  const cancelEdit = () => {
    if (order) fillEditForm(order)
    setEditing(false)
  }

  const saveEdit = async () => {
    if (!order?.id || saving) return

    if (!fullName.trim() || !address.trim() || !mobile1.trim()) {
      toast.error(t('latestOrderEditRequired'))
      return
    }
    if (!/^0\d{9}$/.test(mobile1.trim())) {
      toast.error(t('latestOrderPhoneInvalid'))
      return
    }
    if (mobile2.trim() && !/^0\d{9}$/.test(mobile2.trim())) {
      toast.error(t('latestOrderPhoneInvalid'))
      return
    }
    if (!lines.length) {
      toast.error(t('needProducts'))
      return
    }
    for (const line of lines) {
      if (!line.productId || !line.color || line.qty < 1) {
        toast.error(t('latestOrderItemsInvalid'))
        return
      }
    }

    let paid = num(amountPaid)
    if (status === 'full_payment') paid = grandTotal
    else if (
      status === 'pending' ||
      status === 'web_order' ||
      status === 'chatbot'
    ) {
      paid = 0
    } else if (status === 'half_payment') {
      if (!(paid > 0 && paid < grandTotal)) {
        toast.error(t('latestOrderHalfPaymentInvalid'))
        return
      }
    }

    setSaving(true)
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName.trim(),
          address: address.trim(),
          mobile_1: mobile1.trim(),
          mobile_2: mobile2.trim() || null,
          whatsapp_phone: whatsappPhone.trim() || null,
          city: city.trim() || null,
          order_status: status,
          shipping_method: shippingMethod,
          courier_charge: courierNum,
          total_amount: grandTotal,
          amount_paid: paid,
          tracking_number: trackingNumber.trim() || null,
          sale_type: saleType,
          payment_method: paymentMethod.trim() || 'Cash on Delivery',
          admin_notes: adminNotes.trim() || null,
          items: lines.map((l) => ({
            productId: l.productId,
            name: l.name,
            color: l.color,
            price: l.price,
            quantity: l.qty,
            ...(l.image ? { image: l.image } : {}),
          })),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(
          typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`,
        )
      }
      const updated = (data?.order as LadiesbagsOrder | undefined) ?? {
        ...order,
        full_name: fullName.trim(),
        address: address.trim(),
        mobile_1: mobile1.trim(),
        mobile_2: mobile2.trim() || undefined,
        whatsapp_phone: whatsappPhone.trim() || undefined,
        city: city.trim() || undefined,
        order_status: status,
        shipping_method: shippingMethod,
        courier_charge: courierNum,
        total_amount: grandTotal,
        amount_paid: paid,
        tracking_number: trackingNumber.trim() || undefined,
        sale_type: saleType,
        payment_method: paymentMethod.trim(),
        admin_notes: adminNotes.trim() || undefined,
        items: lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          color: l.color,
          price: l.price,
          quantity: l.qty,
          image: l.image,
        })),
      }
      setOrder(updated)
      fillEditForm(updated)
      setEditing(false)
      toast.success(t('latestOrderSaved'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('latestOrderSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const sendCustomerLink = async () => {
    if (!order || !trackingUrl || sendingLink) return
    setSendingLink(true)
    try {
      await onSendText(trackingUrl)
      toast.success(t('latestOrderLinkSent'))
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('latestOrderLinkSendFailed'),
      )
    } finally {
      setSendingLink(false)
    }
  }

  const addPickedLine = (item: OrderLineItem) => {
    const productId = (item.productId || '').trim()
    if (!productId) {
      toast.error(t('latestOrderItemsInvalid'))
      return
    }
    setLines((prev) => [
      ...prev,
      {
        productId,
        name: item.name,
        color: item.color,
        qty: Math.max(1, item.qty || 1),
        price: Number(item.price) || 0,
        image: item.image,
      },
    ])
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('latestOrderTitle')}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {loading ? (
              <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('latestOrderSearching')}
              </div>
            ) : null}

            {!loading && error ? (
              <div className="space-y-3 py-4">
                <p className="text-sm text-destructive">{error}</p>
                <div className="text-xs text-muted-foreground">
                  {normalizeSlMobile10(contactPhone || '') ? (
                    <p>
                      {t('latestOrderTriedChat', {
                        phone: normalizeSlMobile10(contactPhone || ''),
                      })}
                    </p>
                  ) : (
                    <p>{t('latestOrderNoChatPhone')}</p>
                  )}
                  {selectionPhones[0] ? (
                    <p>
                      {t('latestOrderTriedSelection', {
                        phone: selectionPhones[0],
                      })}
                    </p>
                  ) : (
                    <p>{t('latestOrderNoSelectionPhone')}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void runSearch()}
                >
                  {t('latestOrderRetry')}
                </Button>
              </div>
            ) : null}

            {!loading && order && !editing ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">{labelId}</span>
                  {matchedPhone ? (
                    <span>
                      {searchSource === 'selection'
                        ? t('latestOrderMatchedSelection', {
                            phone: matchedPhone,
                          })
                        : t('latestOrderMatchedChat', { phone: matchedPhone })}
                    </span>
                  ) : null}
                </div>

                <div className="overflow-x-auto">
                  <OrderCard order={order} className="mx-auto" />
                </div>

                {(order.admin_notes || order.payment_method) && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1">
                    {order.payment_method ? (
                      <p>
                        <span className="text-muted-foreground">
                          {t('latestOrderPaymentMethod')}:{' '}
                        </span>
                        {order.payment_method}
                      </p>
                    ) : null}
                    {order.admin_notes ? (
                      <p>
                        <span className="text-muted-foreground">
                          {t('latestOrderAdminNotes')}:{' '}
                        </span>
                        {order.admin_notes}
                      </p>
                    ) : null}
                  </div>
                )}

                {!trackingUrl ? (
                  <p className="text-xs text-muted-foreground">
                    {t('latestOrderLinkUnavailable')}
                  </p>
                ) : null}
              </div>
            ) : null}

            {!loading && order && editing ? (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('latestOrderFullName')}</Label>
                    <Input
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('latestOrderAddress')}</Label>
                    <Textarea
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      rows={3}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderMobile1')}</Label>
                    <Input
                      value={mobile1}
                      onChange={(e) => setMobile1(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderMobile2')}</Label>
                    <Input
                      value={mobile2}
                      onChange={(e) => setMobile2(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderWhatsapp')}</Label>
                    <Input
                      value={whatsappPhone}
                      onChange={(e) => setWhatsappPhone(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderCity')}</Label>
                    <Input
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderStatus')}</Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                      disabled={saving}
                    >
                      {ORDER_STATUS_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {ORDER_STATUS_LABELS[value] || value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderShipping')}</Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none"
                      value={shippingMethod}
                      onChange={(e) => setShippingMethod(e.target.value)}
                      disabled={saving}
                    >
                      {SHIPPING_METHOD_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderCourierCharge')}</Label>
                    <Input
                      type="number"
                      min={0}
                      value={courierCharge}
                      onChange={(e) => setCourierCharge(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderAmountPaid')}</Label>
                    <Input
                      type="number"
                      min={0}
                      value={amountPaid}
                      onChange={(e) => setAmountPaid(e.target.value)}
                      disabled={
                        saving ||
                        status === 'full_payment' ||
                        status === 'pending' ||
                        status === 'web_order' ||
                        status === 'chatbot'
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderTracking')}</Label>
                    <Input
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('latestOrderSaleType')}</Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm outline-none"
                      value={saleType}
                      onChange={(e) => setSaleType(e.target.value)}
                      disabled={saving}
                    >
                      <option value="retail">Retail</option>
                      <option value="wholesale">Wholesale</option>
                    </select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('latestOrderPaymentMethod')}</Label>
                    <Input
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('latestOrderAdminNotes')}</Label>
                    <Textarea
                      value={adminNotes}
                      onChange={(e) => setAdminNotes(e.target.value)}
                      rows={2}
                      disabled={saving}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>{t('products')}</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7"
                      disabled={saving}
                      onClick={() => setPickerOpen(true)}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      {t('addProduct')}
                    </Button>
                  </div>
                  {lines.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('noItemsYet')}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {lines.map((it, idx) => (
                        <li
                          key={`${it.productId}-${it.color}-${idx}`}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
                        >
                          <span className="min-w-0 truncate">
                            {it.name}
                            {it.color ? ` (${it.color})` : ''} × {it.qty} —{' '}
                            {formatLkr(it.price * it.qty)}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              setLines((prev) =>
                                prev.filter((_, i) => i !== idx),
                              )
                            }
                            aria-label={t('removeItem')}
                            disabled={saving}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('latestOrderTotalHint', {
                      items: formatLkr(itemsTotal),
                      shipping: formatLkr(courierNum),
                      total: formatLkr(grandTotal),
                    })}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving || sendingLink}
            >
              {t('cancel')}
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              {!loading && order && !editing ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!trackingUrl || sendingLink}
                    onClick={() => void sendCustomerLink()}
                    title={
                      trackingUrl
                        ? trackingUrl
                        : t('latestOrderLinkUnavailable')
                    }
                  >
                    {sendingLink ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Link2 className="mr-2 h-4 w-4" />
                    )}
                    {t('latestOrderSendCustomerLink')}
                  </Button>
                  <Button type="button" onClick={startEdit}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t('latestOrderEdit')}
                  </Button>
                </>
              ) : null}
              {!loading && order && editing ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={cancelEdit}
                    disabled={saving}
                  >
                    {t('latestOrderCancelEdit')}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void saveEdit()}
                    disabled={saving}
                  >
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {t('latestOrderSave')}
                  </Button>
                </>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrderProductPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={addPickedLine}
        title={t('addProductToOrder')}
        addLabel={t('addToOrder')}
      />
    </>
  )
}
