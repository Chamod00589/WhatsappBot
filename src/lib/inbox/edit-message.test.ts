import { describe, expect, it } from 'vitest'
import { isMessageEditable, MESSAGE_EDIT_WINDOW_MS } from './edit-message'

function msg(
  overrides: Partial<{
    deleted_at: string | null
    sender_type: string
    content_type: string
    created_at: string
    id: string
  }> = {},
) {
  return {
    sender_type: 'agent',
    content_type: 'text',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('isMessageEditable', () => {
  it('allows recent outbound text', () => {
    expect(isMessageEditable(msg())).toBe(true)
  })

  it('allows media captions', () => {
    expect(isMessageEditable(msg({ content_type: 'image' }))).toBe(true)
  })

  it('rejects customer messages', () => {
    expect(isMessageEditable(msg({ sender_type: 'customer' }))).toBe(false)
  })

  it('rejects deleted messages', () => {
    expect(
      isMessageEditable(msg({ deleted_at: new Date().toISOString() })),
    ).toBe(false)
  })

  it('rejects messages older than the edit window', () => {
    expect(
      isMessageEditable(
        msg({
          created_at: new Date(
            Date.now() - MESSAGE_EDIT_WINDOW_MS - 1000,
          ).toISOString(),
        }),
      ),
    ).toBe(false)
  })

  it('rejects templates and interactive', () => {
    expect(isMessageEditable(msg({ content_type: 'template' }))).toBe(false)
    expect(isMessageEditable(msg({ content_type: 'interactive' }))).toBe(false)
  })
})
