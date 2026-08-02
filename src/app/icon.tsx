import { ImageResponse } from 'next/og'
import { BrandIconMark } from '@/lib/brand-icon'

// Replaces the default Next.js favicon with the brand mark — Hostinger
// violet rounded square + white chat-square glyph — matching the
// sidebar logo in `src/components/layout/sidebar.tsx`.

export const runtime = 'edge'
export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(<BrandIconMark size={32} radius={6} strokeWidth={2.5} />, {
    ...size,
  })
}
