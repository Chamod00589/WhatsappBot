import { describe, expect, it } from 'vitest'
import {
  buildGeminiAttempts,
  GEMINI_MODEL_31_FLASH_LITE,
  GEMINI_MODEL_35_FLASH_LITE,
} from './gemini'

describe('buildGeminiAttempts', () => {
  it('uses key2/3.5 → key1/3.1 → key2/3.1 when both keys set', () => {
    const attempts = buildGeminiAttempts({
      apiKey: 'key-one-aaaaaaaa',
      apiKey2: 'key-two-bbbbbbbb',
    })
    expect(attempts.map((a) => a.label)).toEqual([
      `key2/${GEMINI_MODEL_35_FLASH_LITE}`,
      `key1/${GEMINI_MODEL_31_FLASH_LITE}`,
      `key2/${GEMINI_MODEL_31_FLASH_LITE}`,
    ])
  })

  it('falls back to key1 on 3.5 then 3.1 when only one key', () => {
    const attempts = buildGeminiAttempts({ apiKey: 'key-one-aaaaaaaa' })
    expect(attempts.map((a) => a.label)).toEqual([
      `key1/${GEMINI_MODEL_35_FLASH_LITE}`,
      `key1/${GEMINI_MODEL_31_FLASH_LITE}`,
    ])
  })
})
