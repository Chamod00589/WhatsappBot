import type { AiConfigWithSales } from './types'

/** OpenAI-compatible tool definitions for the Sales Agent. */
export function buildSalesAgentTools(caps: AiConfigWithSales) {
  const tools: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }> = []

  if (caps.productMatch || caps.customQrMatch) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_quick_reply',
        description:
          'Send a saved quick reply to the customer by catalog_message_id or quick_reply id. Prefer this over inventing product details.',
        parameters: {
          type: 'object',
          properties: {
            catalog_message_id: {
              type: 'string',
              description: 'ladiesbags catalog quick message id when known',
            },
            quick_reply_id: {
              type: 'string',
              description: 'Local quick_replies.id',
            },
            reason: { type: 'string' },
          },
        },
      },
    })
  }

  if (caps.createOrder) {
    tools.push({
      type: 'function',
      function: {
        name: 'create_order',
        description:
          'Create an order when the customer sent name, address, and at least one phone, plus bag name/color/qty. Pass the raw address message and line items.',
        parameters: {
          type: 'object',
          properties: {
            address_text: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  productId: { type: 'string' },
                  name: { type: 'string' },
                  color: { type: 'string' },
                  quantity: { type: 'number' },
                  price: { type: 'number' },
                },
                required: ['name', 'quantity', 'price'],
              },
            },
          },
          required: ['address_text', 'items'],
        },
      },
    })
  }

  if (caps.quotation) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_quotation',
        description: 'Send a price quotation for selected bags.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  color: { type: 'string' },
                  quantity: { type: 'number' },
                  price: { type: 'number' },
                  productId: { type: 'string' },
                },
                required: ['name', 'quantity', 'price'],
              },
            },
          },
          required: ['items'],
        },
      },
    })
  }

  if (caps.tracking) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_tracking',
        description: 'Send tracking info for the customer latest order.',
        parameters: { type: 'object', properties: {} },
      },
    })
  }

  if (caps.editOrder) {
    tools.push({
      type: 'function',
      function: {
        name: 'edit_order',
        description: 'Update fields on an existing ladiesbags order.',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            patch: { type: 'object' },
          },
          required: ['order_id', 'patch'],
        },
      },
    })
  }

  tools.push({
    type: 'function',
    function: {
      name: 'mark_human',
      description:
        'Escalate to a human agent. Use for wholesale, complaints, unknown data, or when the customer asks for a person.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  })

  return tools
}

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}
