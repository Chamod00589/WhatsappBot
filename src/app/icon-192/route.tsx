import { ImageResponse } from 'next/og'
import { BrandIconMark } from '@/lib/brand-icon'

export const runtime = 'edge'

export function GET() {
  return new ImageResponse(<BrandIconMark size={192} radius={36} />, {
    width: 192,
    height: 192,
  })
}
