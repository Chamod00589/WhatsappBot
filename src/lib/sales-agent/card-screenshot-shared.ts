import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { Resvg } from '@resvg/resvg-js'

export const CARD_W = 360
export const CARD_BG = '#182229'
export const CARD_BORDER = '#2a3942'
export const ROW_BG = '#111b21'
export const THUMB_BG = '#0b141a'
export const MUTED = '#8696a0'
export const BODY = '#cfd7db'
export const FG = '#e9edef'
/** Bundled via assets/fonts + @resvg/resvg-js (Sharp SVG text has no fonts). */
export const FONT = 'Noto Sans'

function resolveFontDir(): string {
  const candidates = [
    path.join(process.cwd(), 'assets', 'fonts'),
    path.join(__dirname, '..', '..', '..', '..', 'assets', 'fonts'),
    path.join(__dirname, '..', '..', '..', 'assets', 'fonts'),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'NotoSans-Regular.ttf'))) return dir
  }
  return candidates[0]
}

function loadFontFiles(): string[] {
  const dir = resolveFontDir()
  const files = [
    path.join(dir, 'NotoSans-Regular.ttf'),
    path.join(dir, 'NotoSans-Bold.ttf'),
  ].filter((f) => fs.existsSync(f))
  if (!files.length) {
    throw new Error(
      `Card screenshot fonts missing under ${dir} (need NotoSans-Regular.ttf / NotoSans-Bold.ttf)`,
    )
  }
  return files
}

export function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Tampermonkey order money: `LKR 1,234.00` */
export function formatOrderMoneyTm(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  return `LKR ${v.toLocaleString('en-US')}.00`
}

/** Tampermonkey quotation money: `Rs 1,234` */
export function formatQuotationMoneyTm(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  return `Rs ${v.toLocaleString('en-US')}`
}

export function wrapLines(
  text: string,
  maxChars: number,
  maxLines = 3,
): string[] {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return ['']
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length <= maxChars) {
      cur = next
      continue
    }
    if (cur) lines.push(cur)
    cur = w.length > maxChars ? w.slice(0, maxChars) : w
    if (lines.length >= maxLines - 1) break
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (
    lines.length === maxLines &&
    words.join(' ').length > lines.join(' ').length
  ) {
    const last = lines[maxLines - 1]
    lines[maxLines - 1] =
      last.length > 3 ? `${last.slice(0, Math.max(1, last.length - 1))}…` : last
  }
  return lines.length ? lines : ['']
}

export async function loadThumbBuffer(
  url: string | undefined | null,
  size = 56,
): Promise<Buffer | null> {
  if (!url) return null
  let abs = String(url).trim()
  if (!abs) return null
  if (abs.startsWith('/api/orders/proxy-image')) {
    try {
      const u = new URL(abs, 'http://local')
      abs = u.searchParams.get('url') || abs
    } catch {
      /* keep */
    }
  }
  if (!/^https?:\/\//i.test(abs)) return null
  try {
    const res = await fetch(abs, { cache: 'no-store' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength < 32) return null
    return sharp(buf)
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 82 })
      .toBuffer()
  } catch {
    return null
  }
}

/** Rasterize SVG with bundled Noto Sans so text is visible (Sharp SVG text is blank). */
export function renderSvgToPng(svg: string): Buffer {
  const fontFiles = loadFontFiles()
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: CARD_W * 2 },
    font: {
      fontFiles,
      loadSystemFonts: false,
      defaultFontFamily: FONT,
    },
    background: CARD_BG,
  })
  const png = Buffer.from(resvg.render().asPng())
  if (png.byteLength < 500) {
    throw new Error('Card SVG render produced empty image')
  }
  return png
}

export async function encodeCardJpeg(
  svg: string,
  composites: Array<{ input: Buffer; left: number; top: number }>,
): Promise<Buffer> {
  // Render at 2x for crisp text, then scale composite coords.
  const scale = 2
  let base = renderSvgToPng(svg)

  if (composites.length) {
    const scaled = await Promise.all(
      composites.map(async (c) => {
        const meta = await sharp(c.input).metadata()
        const tw = Math.max(1, Math.round((meta.width || 56) * scale))
        const th = Math.max(1, Math.round((meta.height || 56) * scale))
        return {
          input: await sharp(c.input)
            .resize(tw, th, { fit: 'cover' })
            .jpeg({ quality: 85 })
            .toBuffer(),
          left: Math.round(c.left * scale),
          top: Math.round(c.top * scale),
        }
      }),
    )
    base = await sharp(base).composite(scaled).png().toBuffer()
  }

  // Output display width 360 for WhatsApp
  const jpeg = await sharp(base)
    .resize(CARD_W, null, { fit: 'inside' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()
  if (jpeg.byteLength < 500) {
    throw new Error('Card JPEG encode produced empty image')
  }
  return jpeg
}

export function cardShell(height: number, inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${CARD_W}" height="${height}" viewBox="0 0 ${CARD_W} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${height}" rx="8" fill="${CARD_BG}"/>
  <rect x="0.5" y="0.5" width="${CARD_W - 1}" height="${height - 1}" rx="8" fill="none" stroke="${CARD_BORDER}"/>
  ${inner}
</svg>`
}
