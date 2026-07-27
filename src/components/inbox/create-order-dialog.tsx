'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { SendMediaPayload } from '@/components/inbox/message-composer'
import { OrderCard, type LadiesbagsOrder } from '@/components/inbox/order-card'
import { OrderProductPicker } from '@/components/inbox/order-product-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { captureElementAsPngFile } from '@/lib/orders/capture-card'
import {
  buildOrderScreenshotCaption,
  buildOrderTextWithProducts,
  DUPLICATE_ORDER_DAYS,
  formatLkr,
  normalizeOrderTextMobilePhones,
  type OrderLineItem,
  type OrderPaymentStatus,
} from '@/lib/orders/constants'
import { uploadAccountMedia } from '@/lib/storage/upload-media'
import { prefetchOrderPickerCatalog } from '@/lib/orders/picker-catalog-cache'
import { cn } from '@/lib/utils'

const CHAT_MEDIA_BUCKET = 'chat-media'

interface CreateOrderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill address text (from “Use for order”). */
  seedText?: string | null
  contactPhone?: string | null
  onSendMedia: (payload: SendMediaPayload) => void | Promise<void>
}

export function CreateOrderDialog({
  open,
  onOpenChange,
  seedText,
  contactPhone,
  onSendMedia,
}: CreateOrderDialogProps) {
  const t = useTranslations('Inbox.orders')
  const [sourceText, setSourceText] = useState('')
  const [orderText, setOrderText] = useState('')
  const [items, setItems] = useState<OrderLineItem[]>([])
  const [paymentStatus, setPaymentStatus] =
    useState<OrderPaymentStatus>('pending')
  const [amountPaid, setAmountPaid] = useState('')
  const [sendScreenshot, setSendScreenshot] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [captureOrder, setCaptureOrder] = useState<LadiesbagsOrder | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const didAutoExtract = useRef(false)

  useEffect(() => {
    if (!open) {
      didAutoExtract.current = false
      setCaptureOrder(null)
      return
    }
    prefetchOrderPickerCatalog()
    const seed = (seedText || '').trim()
    setSourceText(seed)
    setOrderText('')
    setItems([])
    setPaymentStatus('pending')
    setAmountPaid('')
    setSendScreenshot(true)
    setStatus('')
    setStatusError(false)
  }, [open, seedText])

  const runExtract = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) {
        setStatus(t('needAddressText'))
        setStatusError(true)
        return
      }
      setExtracting(true)
      setStatus(t('extracting'))
      setStatusError(false)
      try {
        const res = await fetch('/api/orders/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (data?.code === 'ai_not_configured') {
            throw new Error(t('aiNotConfigured'))
          }
          throw new Error(data?.error || `HTTP ${res.status}`)
        }
        const reply = typeof data.reply === 'string' ? data.reply.trim() : ''
        if (!reply) throw new Error(t('extractEmpty'))
        setOrderText(reply)
        setStatus(t('extractDone'))
        setStatusError(false)
      } catch (err) {
        const msg = err instanceof Error ? err.message : t('extractFailed')
        setStatus(msg)
        setStatusError(true)
      } finally {
        setExtracting(false)
      }
    },
    [t],
  )

  useEffect(() => {
    if (!open || didAutoExtract.current) return
    const seed = (seedText || '').trim()
    if (!seed) return
    didAutoExtract.current = true
    void runExtract(seed)
  }, [open, seedText, runExtract])

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx))
  }

  const createOrder = async () => {
    if (creating) return
    let text = normalizeOrderTextMobilePhones(
      buildOrderTextWithProducts(orderText, items),
    ).trim()
    if (!text.includes('@@')) {
      setStatus(t('needOrderText'))
      setStatusError(true)
      return
    }
    if (!items.length && !text.includes('::')) {
      setStatus(t('needProducts'))
      setStatusError(true)
      return
    }
    if (paymentStatus === 'half_payment') {
      const amt = Number(amountPaid)
      if (!Number.isFinite(amt) || amt <= 0) {
        setStatus(t('needHalfAmount'))
        setStatusError(true)
        return
      }
    }

    setCreating(true)
    setStatus(t('creating'))
    setStatusError(false)

    try {
      const phone = (contactPhone || '').trim()
      if (phone) {
        const dupRes = await fetch(
          `/api/orders/by-phone?phone=${encodeURIComponent(phone)}&days=${DUPLICATE_ORDER_DAYS}&whatsapp_only=1`,
        )
        const dupData = await dupRes.json().catch(() => ({}))
        if (dupRes.ok && dupData?.order) {
          throw new Error(t('duplicateOrder', { days: DUPLICATE_ORDER_DAYS }))
        }
      }

      const payload: Record<string, unknown> = {
        text,
        payment_status: paymentStatus,
      }
      // Unpaid inbox orders → ChatBot status on ladiesbags (not Pending).
      if (paymentStatus === 'pending') {
        payload.order_status = 'chatbot'
      }
      if (phone) payload.whatsapp_phone = phone
      if (paymentStatus === 'half_payment') {
        payload.amount_paid = Number(amountPaid)
      }

      const res = await fetch('/api/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)

      toast.success(t('createSuccess'))

      if (sendScreenshot && phone) {
        setStatus(t('loadingOrderForScreenshot'))
        const byRes = await fetch(
          `/api/orders/by-phone?phone=${encodeURIComponent(phone)}`,
        )
        const byData = await byRes.json().catch(() => ({}))
        if (!byRes.ok || !byData?.order) {
          throw new Error(t('screenshotLoadFailed'))
        }
        const order = byData.order as LadiesbagsOrder
        flushSync(() => {
          setCaptureOrder(order)
        })
        await new Promise((r) => requestAnimationFrame(() => r(undefined)))
        await new Promise((r) => setTimeout(r, 50))

        const el = cardRef.current
        if (!el) throw new Error(t('screenshotCaptureFailed'))

        setStatus(t('capturingScreenshot'))
        const file = await captureElementAsPngFile(el, 'order')
        const { publicUrl, path } = await uploadAccountMedia(
          CHAT_MEDIA_BUCKET,
          file,
        )
        const caption = buildOrderScreenshotCaption(order, catalogBaseUrl())
        await onSendMedia({
          kind: 'image',
          mediaUrl: publicUrl,
          path,
          caption,
          filename: file.name,
        })
        toast.success(t('screenshotSent'))
      }

      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('createFailed')
      setStatus(msg)
      setStatusError(true)
      toast.error(msg)
    } finally {
      setCreating(false)
      setCaptureOrder(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] max-w-xl flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('createOrderTitle')}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <div className="space-y-1.5">
              <Label>{t('customerMessage')}</Label>
              <Textarea
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                rows={3}
                placeholder={t('customerMessagePlaceholder')}
                disabled={extracting || creating}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={extracting || creating || !sourceText.trim()}
                onClick={() => void runExtract(sourceText)}
              >
                {extracting ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('formatWithAI')}
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label>{t('orderText')}</Label>
              <Textarea
                value={orderText}
                onChange={(e) => setOrderText(e.target.value)}
                rows={6}
                className="font-mono text-xs"
                placeholder="@@Name&#10;@@Address…&#10;@@077…"
                disabled={creating}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t('products')}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={creating}
                  onClick={() => setPickerOpen(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t('addProduct')}
                </Button>
              </div>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noItemsYet')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {items.map((it, idx) => (
                    <li
                      key={`${it.name}-${it.color}-${idx}`}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {it.name}
                        {it.color ? ` (${it.color})` : ''} × {it.qty} —{' '}
                        {formatLkr(
                          (Number(it.price) || 0) * Math.max(1, it.qty || 1),
                        )}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeItem(idx)}
                        aria-label={t('removeItem')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t('payment')}</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['pending', t('paymentNotPaid')],
                    ['full_payment', t('paymentFull')],
                    ['half_payment', t('paymentHalf')],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    disabled={creating}
                    onClick={() => setPaymentStatus(value)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs',
                      paymentStatus === value
                        ? 'border-primary bg-primary/10'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {paymentStatus === 'half_payment' ? (
                <Input
                  type="number"
                  min={1}
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value)}
                  placeholder={t('amountPaidPlaceholder')}
                  className="w-40"
                  disabled={creating}
                />
              ) : null}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={sendScreenshot}
                onCheckedChange={(checked) => setSendScreenshot(!!checked)}
                disabled={creating}
              />
              {t('sendScreenshotAfter')}
            </label>

            {status ? (
              <p
                className={cn(
                  'text-xs',
                  statusError ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {status}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => void createOrder()}
              disabled={creating || extracting}
            >
              {creating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t('createOrder')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrderProductPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(item) => setItems((prev) => [...prev, item])}
        title={t('addProductToOrder')}
        addLabel={t('addToOrder')}
      />

      {/* Offscreen capture target — painted only while sending screenshot */}
      {captureOrder ? (
        <div
          className="pointer-events-none fixed left-[-9999px] top-0 z-[-1]"
          aria-hidden
        >
          <div ref={cardRef}>
            <OrderCard order={captureOrder} capture />
          </div>
        </div>
      ) : null}
    </>
  )
}
