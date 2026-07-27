/**
 * Prepare ladiesbags.lk catalog images for WhatsApp Cloud API.
 *
 * Most product photos are WebP. Meta's image messages accept JPEG/PNG
 * reliably (and often reject WebP when fetched via `link`), so we
 * download each image server-side and convert WebP → JPEG with sharp
 * before uploading to Meta. Nothing is written to Supabase storage.
 */

import sharp from 'sharp'

/** WhatsApp image hard limit is 5 MB; leave headroom after encode. */
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024
const MAX_EDGE = 1600

export interface PreparedWhatsAppImage {
  bytes: Uint8Array
  mimeType: 'image/jpeg' | 'image/png'
  filename: string
}

function guessFilename(url: string, ext: string): string {
  try {
    const base = new URL(url).pathname.split('/').pop() || 'product'
    const stem = base.replace(/\.[^.]+$/, '') || 'product'
    return `${stem}.${ext}`
  } catch {
    return `product.${ext}`
  }
}

/**
 * Fetch a catalog image URL and return JPEG/PNG bytes Meta will accept.
 */
export async function prepareCatalogImageForWhatsApp(
  imageUrl: string,
): Promise<PreparedWhatsAppImage> {
  const res = await fetch(imageUrl, {
    cache: 'no-store',
    headers: { Accept: 'image/*,*/*' },
  })
  if (!res.ok) {
    throw new Error(`Image download failed (HTTP ${res.status}): ${imageUrl}`)
  }

  const source = Buffer.from(await res.arrayBuffer())
  if (!source.byteLength) {
    throw new Error(`Empty image: ${imageUrl}`)
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase()
  const isPng =
    contentType.includes('image/png') || /\.png(\?|$)/i.test(imageUrl)
  const isJpeg =
    contentType.includes('image/jpeg') ||
    contentType.includes('image/jpg') ||
    /\.jpe?g(\?|$)/i.test(imageUrl)

  // Already JPEG/PNG and under the size cap — send as-is (no re-encode).
  if ((isJpeg || isPng) && source.byteLength <= MAX_IMAGE_BYTES) {
    return {
      bytes: new Uint8Array(source),
      mimeType: isPng ? 'image/png' : 'image/jpeg',
      filename: guessFilename(imageUrl, isPng ? 'png' : 'jpg'),
    }
  }

  // WebP / oversized / unknown → JPEG (Meta-safe).
  let quality = 85
  let pipeline = sharp(source)
    .rotate()
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })

  let out = await pipeline.toBuffer()
  while (out.byteLength > MAX_IMAGE_BYTES && quality > 45) {
    quality -= 10
    out = await sharp(source)
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
  }

  if (out.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image still too large after compress: ${imageUrl}`)
  }

  return {
    bytes: new Uint8Array(out),
    mimeType: 'image/jpeg',
    filename: guessFilename(imageUrl, 'jpg'),
  }
}
