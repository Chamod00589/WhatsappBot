import type { CatalogProduct } from '@/lib/catalog/products'
import { resolveCatalogImageUrl } from '@/lib/catalog/products'
import type { OrderLineItem } from '@/lib/orders/constants'

export function catalogImageForColor(
  product: CatalogProduct,
  color: string,
): string {
  const want = (color || '').trim().toLowerCase()
  let ci = want
    ? product.colors.findIndex((c) => c.trim().toLowerCase() === want)
    : -1
  // Same-color variants from ImageIdentify (Pink__2) already normalized upstream;
  // still try prefix match if an exact slot is missing.
  if (ci < 0 && want) {
    ci = product.colors.findIndex((c) => {
      const n = c.trim().toLowerCase()
      return n === want || want.startsWith(`${n}__`) || n.startsWith(want)
    })
  }
  const idx =
    ci < 0
      ? 0
      : Math.min(ci, Math.max(0, product.images.length - 1))
  const raw = product.images[idx] ?? product.images[0] ?? ''
  return resolveCatalogImageUrl(raw)
}

export function toPickedLine(
  product: CatalogProduct,
  color: string,
  qty: number,
): OrderLineItem {
  return {
    productId: product.id,
    name: product.name,
    color,
    qty: Math.max(1, qty || 1),
    price: Number(product.price) || 0,
    image: catalogImageForColor(product, color),
  }
}

/** Route catalog images through our proxy so html-to-image can embed them. */
export function proxiedImageUrl(absoluteUrl: string | undefined | null): string {
  if (!absoluteUrl) return ''
  if (absoluteUrl.startsWith('data:') || absoluteUrl.startsWith('blob:')) {
    return absoluteUrl
  }
  return `/api/orders/proxy-image?url=${encodeURIComponent(absoluteUrl)}`
}
