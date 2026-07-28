/**
 * Build WhatsApp text for sending public tracking info
 * (mirrors ladiesbags public-tracking-dialog content).
 */

import { formatOrderLabelBarcode } from '@/lib/orders/constants'
import { catalogBaseUrl } from '@/lib/catalog/products'

export type TrackingStatusLatest = {
  status?: string | null
  statusDate?: string | null
  remark?: string | null
}

export type TrackingStatusContactBranch = {
  location: string
  phone: string
  phoneDisplay: string
}

export type TrackingStatusPayload = {
  success?: boolean
  trackingNo?: string
  latest?: TrackingStatusLatest | null
  isShipped?: boolean
  contactBranch?: TrackingStatusContactBranch | null
  order?: {
    order_status?: string | null
    shipped_at?: string | null
  } | null
  error?: string
}

function formatStatusDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString('en-LK', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Public customer tracking page URL (LB order label preferred). */
export function publicCustomerTrackingUrl(options: {
  orderId?: string | null
  trackingNumber?: string | null
}): string {
  const label = formatOrderLabelBarcode(options.orderId)
  const trackId =
    (label && label.length > 2 ? label : '') ||
    options.trackingNumber?.trim() ||
    ''
  const base = catalogBaseUrl().replace(/\/$/, '')
  return `${base}/tracking/${encodeURIComponent(trackId || 'unknown')}`
}

/** Plain text tracking info message (no interactive buttons). */
export function buildCustomerTrackingText(options: {
  displayTrackingId: string
  trackingUrl: string
  status: TrackingStatusPayload | null
}): string {
  const trackingId = options.displayTrackingId.trim().toUpperCase()
  const url = options.trackingUrl
  const status = options.status
  const isShipped =
    status?.isShipped === true ||
    (status?.order?.order_status ?? '').toLowerCase() === 'shipped' ||
    Boolean(status?.order?.shipped_at?.trim())

  const branch = status?.contactBranch
  const branchLocation = branch?.location?.trim() || 'Thambuttegama'
  const phoneDisplay =
    branch?.phoneDisplay?.trim() ||
    (branch?.phone
      ? `0${branch.phone.replace(/\D/g, '').replace(/^0/, '')}`
      : '') ||
    '0763568602'

  const latest = status?.latest
  const latestStatus = latest?.status?.trim() || ''
  const latestDate = latest?.statusDate
    ? formatStatusDate(latest.statusDate)
    : ''
  const latestRemark = latest?.remark?.trim() || ''

  const sections: string[] = []

  if (isShipped) {
    sections.push(
      '*Call for parcel info*',
      '',
      `${branchLocation} branch`,
      '',
      phoneDisplay,
      `Call and ask about your parcel. Mention tracking number ${trackingId}.`,
      '',
      `ඉහත අංකයට කතාකර ${trackingId} මෙම අංකය සදහන් කරමින් පාර්සලය ගැන විමසන්න.`,
    )
  } else {
    sections.push(
      '*Preparing to ship*',
      '',
      'Your parcel is getting ready to ship.',
      '',
      'ඔබේ පාර්සලය යැවීමට සූදානම් වෙමින් පවතී. ඉක්මනින් යවනු ලැබේ.',
    )
  }

  if (latestStatus) {
    sections.push('', '*Latest status*', '', latestStatus)
    if (latestDate || latestRemark) {
      sections.push('', [latestDate, latestRemark].filter(Boolean).join(' · '))
    }
  }

  sections.push(
    '',
    'පාර්සලයේ බෙදාහැරීමේ තොරතුරු මෙතනින් බලන්න පුලුවන්:',
    url,
  )

  return sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
