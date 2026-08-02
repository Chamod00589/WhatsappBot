import { ImageResponse } from 'next/og'
import { BrandIconMark } from '@/lib/brand-icon'

export const runtime = 'edge'
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(<BrandIconMark size={180} radius={40} />, {
    ...size,
  })
}
