'use client'

import type { CatalogProduct } from '@/lib/catalog/products'

const CLIENT_TTL_MS = 10 * 60 * 1000

type CacheEntry = {
  products: CatalogProduct[]
  fetchedAt: number
}

let cache: CacheEntry | null = null
let inflight: Promise<CatalogProduct[]> | null = null

export function getCachedOrderPickerProducts(): CatalogProduct[] | null {
  if (!cache) return null
  if (Date.now() - cache.fetchedAt > CLIENT_TTL_MS) return null
  return cache.products
}

export function peekOrderPickerProducts(): CatalogProduct[] | null {
  return cache?.products?.length ? cache.products : null
}

/**
 * Load order-picker products with client memory cache + single-flight.
 * `force` bypasses TTL (still shares in-flight request).
 */
export async function loadOrderPickerProducts(
  force = false,
): Promise<CatalogProduct[]> {
  if (!force) {
    const hit = getCachedOrderPickerProducts()
    if (hit) return hit
  }

  if (inflight) return inflight

  inflight = (async () => {
    const res = await fetch('/api/orders/catalog')
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`,
      )
    }
    const products: CatalogProduct[] = Array.isArray(data.products)
      ? data.products
      : []
    cache = { products, fetchedAt: Date.now() }
    return products
  })().finally(() => {
    inflight = null
  })

  return inflight
}

/** Warm the cache before the user opens Add product. */
export function prefetchOrderPickerCatalog(): void {
  if (getCachedOrderPickerProducts()) return
  void loadOrderPickerProducts().catch(() => {
    /* ignore prefetch errors — picker will retry */
  })
}
