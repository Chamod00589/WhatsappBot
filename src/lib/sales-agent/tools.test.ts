import { describe, expect, it } from 'vitest'
import { buildSalesAgentTools, AGENT_TOOL_NAMES } from './tools'
import { DEFAULT_SALES_AGENT_CAPABILITIES } from './types'
import type { AiConfigWithSales } from './types'

function fakeConfig(
  overrides: Partial<AiConfigWithSales> = {},
): AiConfigWithSales {
  return {
    accountId: 'a',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'k',
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 20,
    systemPrompt: '',
    handoffAgentId: null,
    ...DEFAULT_SALES_AGENT_CAPABILITIES,
    ...overrides,
  } as AiConfigWithSales
}

describe('buildSalesAgentTools (FAQ/identify layer)', () => {
  it('exposes identify/FAQ/order tools and find_product for product Details QR', () => {
    const names = buildSalesAgentTools(fakeConfig()).map((t) => t.function.name)
    expect(names).toContain('identify_product')
    expect(names).toContain('find_product')
    expect(names).not.toContain('generate_quote')
    expect(names).not.toContain('update_order')
    expect(names).toContain('create_order')
    expect(names).toContain('answer_delivery')
    expect(names).toContain('answer_policy')
    expect(names).toContain('ask_missing_information')
    expect(names).toContain('confirm_order')
    expect(names).toContain('handover_to_human')
    expect(names).toContain('send_tracking')
  })

  it('hides capability-gated tools when flags are off', () => {
    const names = buildSalesAgentTools(
      fakeConfig({
        identify: false,
        productMatch: false,
        quotation: false,
        createOrder: false,
        editOrder: false,
        customQrMatch: false,
        tracking: false,
      }),
    ).map((t) => t.function.name)

    expect(names).toEqual([
      'ask_missing_information',
      'handover_to_human',
    ])
  })

  it('lists legacy aliases for Anthropic JSON fallback', () => {
    expect(AGENT_TOOL_NAMES).toContain('send_quotation')
    expect(AGENT_TOOL_NAMES).toContain('mark_human')
  })
})
