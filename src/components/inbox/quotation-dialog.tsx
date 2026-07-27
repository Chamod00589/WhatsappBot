'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { SendMediaPayload } from '@/components/inbox/message-composer'
import { OrderProductPicker } from '@/components/inbox/order-product-picker'
import { QuotationCard } from '@/components/inbox/quotation-card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { captureElementAsPngFile } from '@/lib/orders/capture-card'
import {
  formatLkr,
  QUOTATION_SHIPPING_LKR,
  type OrderLineItem,
} from '@/lib/orders/constants'
import { uploadAccountMedia } from '@/lib/storage/upload-media'

const CHAT_MEDIA_BUCKET = 'chat-media'

interface QuotationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSendMedia: (payload: SendMediaPayload) => void | Promise<void>
}

export function QuotationDialog({
  open,
  onOpenChange,
  onSendMedia,
}: QuotationDialogProps) {
  const t = useTranslations('Inbox.orders')
  const [items, setItems] = useState<OrderLineItem[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setItems([])
    setStatus('')
    setSending(false)
  }, [open])

  const itemsSubtotal = items.reduce(
    (sum, it) => sum + (Number(it.price) || 0) * Math.max(1, it.qty || 1),
    0,
  )

  const sendQuotation = async () => {
    if (!items.length || sending) return
    setSending(true)
    setStatus(t('capturingQuotation'))
    try {
      const el = cardRef.current
      if (!el) throw new Error(t('screenshotCaptureFailed'))
      const file = await captureElementAsPngFile(el, 'quotation')
      const { publicUrl, path } = await uploadAccountMedia(
        CHAT_MEDIA_BUCKET,
        file,
      )
      await onSendMedia({
        kind: 'image',
        mediaUrl: publicUrl,
        path,
        filename: file.name,
      })
      toast.success(t('quotationSent'))
      onOpenChange(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('quotationSendFailed')
      setStatus(msg)
      toast.error(msg)
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] max-w-lg flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('quotationTitle')}</DialogTitle>
          </DialogHeader>

          <p className="text-xs text-muted-foreground">{t('quotationHint')}</p>

          <div className="flex items-center justify-between">
            <Label>{t('products')}</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              disabled={sending}
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
                    onClick={() =>
                      setItems((prev) => prev.filter((_, i) => i !== idx))
                    }
                    aria-label={t('removeItem')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="min-h-0 overflow-y-auto rounded-md border border-border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t('preview')}
            </p>
            <div className="flex justify-center">
              <div ref={cardRef}>
                <QuotationCard
                  items={items}
                  emptyLabel={t('quotationEmpty')}
                />
              </div>
            </div>
            {items.length > 0 ? (
              <p className="mt-2 text-center text-[11px] text-muted-foreground">
                {t('quotationTotalHint', {
                  items: formatLkr(itemsSubtotal),
                  shipping: formatLkr(QUOTATION_SHIPPING_LKR),
                  total: formatLkr(itemsSubtotal + QUOTATION_SHIPPING_LKR),
                })}
              </p>
            ) : null}
          </div>

          {status ? (
            <p className="text-xs text-muted-foreground">{status}</p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={sending}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              disabled={!items.length || sending}
              onClick={() => void sendQuotation()}
            >
              {sending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t('sendQuotation')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrderProductPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(item) => setItems((prev) => [...prev, item])}
        title={t('addProductToQuotation')}
        addLabel={t('addToQuotation')}
      />
    </>
  )
}
