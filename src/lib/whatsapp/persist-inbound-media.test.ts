import { describe, expect, it } from 'vitest'
import {
  inboundMediaStoragePath,
  normalizeMimeType,
  proxyMediaUrl,
  storageSafeMimeType,
} from './persist-inbound-media'

describe('proxyMediaUrl', () => {
  it('builds the historical relative proxy path', () => {
    expect(proxyMediaUrl('12345')).toBe('/api/whatsapp/media/12345')
  })
})

describe('inboundMediaStoragePath', () => {
  it('namespaces under account folder with stable media id', () => {
    const account = '11111111-2222-3333-4444-555555555555'
    expect(inboundMediaStoragePath(account, '2482360742243463')).toBe(
      `account-${account}/wa-inbound/2482360742243463`,
    )
  })

  it('sanitizes unsafe media id characters', () => {
    const account = 'a'
    expect(inboundMediaStoragePath(account, '../x?y')).toBe(
      'account-a/wa-inbound/___x_y',
    )
  })
})

describe('mime helpers', () => {
  it('strips codec parameters', () => {
    expect(normalizeMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg')
  })

  it('maps unknown image types onto the allow-list', () => {
    expect(storageSafeMimeType('image/gif')).toBe('image/jpeg')
  })

  it('keeps allowed types', () => {
    expect(storageSafeMimeType('image/webp')).toBe('image/webp')
  })
})
