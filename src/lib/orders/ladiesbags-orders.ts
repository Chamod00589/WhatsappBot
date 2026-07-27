/**
 * Server-side client for ladiesbags.lk order / Gemini APIs.
 * Keeps ORDERS_API_KEY off the browser.
 */

import { catalogBaseUrl } from '@/lib/catalog/products'

export function ordersBaseUrl(): string {
  const raw =
    process.env.LADIESBAGS_ORDERS_URL ||
    process.env.LADIESBAGS_CATALOG_URL ||
    process.env.NEXT_PUBLIC_LADIESBAGS_CATALOG_URL ||
    catalogBaseUrl()
  return raw.replace(/\/$/, '')
}

export function ordersApiKey(): string {
  const key = process.env.ORDERS_API_KEY?.trim()
  if (!key) {
    throw new Error('ORDERS_API_KEY is not configured on the server.')
  }
  return key
}

export class LadiesbagsOrdersError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'LadiesbagsOrdersError'
    this.status = status
    this.body = body
  }
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

export async function ladiesbagsOrdersRequest(
  method: 'GET' | 'POST',
  path: string,
  options?: {
    body?: unknown
    query?: Record<string, string | number | undefined | null>
    /** When false, omit x-api-key (e.g. Gemini public proxy). */
    auth?: boolean
  },
): Promise<unknown> {
  const base = ordersBaseUrl()
  const url = new URL(path.startsWith('http') ? path : `${base}${path}`)
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (options?.auth !== false) {
    headers['x-api-key'] = ordersApiKey()
  }
  if (options?.body != null) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: options?.body != null ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  })

  const json = await parseJson(res)
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `Ladiesbags orders API HTTP ${res.status}`
    throw new LadiesbagsOrdersError(msg, res.status, json)
  }
  return json
}

export async function createOrderOnLadiesbags(payload: {
  text: string
  whatsapp_phone?: string
  payment_status?: string
  /** Unpaid intake status — inbox sends `chatbot`. Ignored when half/full paid. */
  order_status?: string
  amount_paid?: number
}): Promise<unknown> {
  return ladiesbagsOrdersRequest('POST', '/api/orders/create', { body: payload })
}

export async function fetchOrderByPhone(options: {
  phone: string
  days?: number
  whatsappOnly?: boolean
}): Promise<unknown> {
  return ladiesbagsOrdersRequest('GET', '/api/orders/by-phone', {
    query: {
      phone: options.phone,
      days: options.days,
      whatsapp_only: options.whatsappOnly ? '1' : undefined,
    },
  })
}
