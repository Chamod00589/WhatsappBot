import { ImageResponse } from 'next/og'
import { BrandIconMark } from '@/lib/brand-icon'

export const runtime = 'edge'

export function GET() {
  return new ImageResponse(<BrandIconMark size={512} radius={96} />, {
    width: 512,
    height: 512,
  })
}
