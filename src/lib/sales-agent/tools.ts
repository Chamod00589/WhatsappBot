import type { AiConfigWithSales } from './types'

type ToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * OpenAI-compatible tools for the Sales Agent FAQ / identify / order-create layer.
 * Quotation + cart edits are owned by the server extract→validate→quote pipeline
 * (cart-intent-extract + cart-pipeline) — the model must NOT pick products or prices.
 */
export function buildSalesAgentTools(caps: AiConfigWithSales): ToolDef[] {
  const tools: ToolDef[] = []

  if (caps.identify) {
    tools.push({
      type: 'function',
      function: {
        name: 'identify_product',
        description:
          'Identify bag(s) in the customer inbound image(s) via CLIP catalog matching. Catalog supports same-color variants (Pink.webp + Pink__2.webp) and product-only shots (_1.webp). Returns product, color (empty if unknown), confidence. If color is empty / color_unknown is set, ask which color — never invent one. Set send_product_card=true to send the product quick-reply when confidence is high. When cards are sent successfully, the server may auto-send a quotation (quotation_sent=true) via the deterministic quote engine when bag+color+qty are complete.',
        parameters: {
          type: 'object',
          properties: {
            send_product_card: {
              type: 'boolean',
              description:
                'If true, send product QR/card for high-confidence matches (≥90%). Default true.',
            },
          },
        },
      },
    })
  }

  if (caps.productMatch) {
    tools.push({
      type: 'function',
      function: {
        name: 'find_product',
        description:
          'Send the PRODUCT Details Quick Reply card (color photos, price, delivery, available colors) for a catalog bag. PRIORITY: use this when the customer asks which colors a bag has, bag details, photos, or "me bag eke colors". Prefer the bag from Session state / last quotation ("me bag"). Do NOT use answer_policy / custom FAQ for product color/details questions. Pass product_id or product_name from the catalog list.',
        parameters: {
          type: 'object',
          properties: {
            product_name: {
              type: 'string',
              description: 'Bag name, e.g. "Cloudy Shoulder Bag" or "Cloudy"',
            },
            product_id: { type: 'string' },
            catalog_message_id: { type: 'string' },
            quick_reply_id: { type: 'string' },
            color: {
              type: 'string',
              description: 'Optional remembered color (does not change the QR images)',
            },
            quantity: {
              type: 'number',
              description: 'Optional qty to remember for later order',
            },
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
          'Create a ladiesbags order when the customer provided delivery name/address/phone. Bags/colors/qty MUST already be saved in session state from the quotation pipeline — do not pass product lines. Pass only the raw address message.',
        parameters: {
          type: 'object',
          properties: {
            address_text: {
              type: 'string',
              description: 'Raw customer message with name, address, phone',
            },
          },
          required: ['address_text'],
        },
      },
    })
  }

  if (caps.customQrMatch) {
    tools.push({
      type: 'function',
      function: {
        name: 'answer_delivery',
        description:
          'Send the saved delivery/shipping FAQ quick reply. YOU must choose the best match from the FAQ list using each item\'s description (e.g. "Deliver Time and price"). Always pass quick_reply_id (or catalog_message_id). If no FAQ fits, call handover_to_human instead.',
        parameters: {
          type: 'object',
          properties: {
            quick_reply_id: {
              type: 'string',
              description: 'id from the FAQ list',
            },
            catalog_message_id: { type: 'string' },
          },
          required: ['quick_reply_id'],
        },
      },
    })

    tools.push({
      type: 'function',
      function: {
        name: 'answer_policy',
        description:
          'Send a saved policy/FAQ quick reply (payment, returns, COD, etc.). YOU must choose the best match from the FAQ list by reading descriptions. Always pass quick_reply_id. If none fit, call handover_to_human.',
        parameters: {
          type: 'object',
          properties: {
            quick_reply_id: {
              type: 'string',
              description: 'id from the FAQ list',
            },
            catalog_message_id: { type: 'string' },
          },
          required: ['quick_reply_id'],
        },
      },
    })
  }

  tools.push({
    type: 'function',
    function: {
      name: 'ask_missing_information',
      description:
        'Send a short clarifying WhatsApp message when something required is missing (which bag, color, qty, address, phone). Use Singlish/Tanglish per language rules. Do not invent prices or policies — use answer_* tools for FAQ.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Short clarification to send the customer',
          },
        },
        required: ['message'],
      },
    },
  })

  if (caps.createOrder) {
    tools.push({
      type: 'function',
      function: {
        name: 'confirm_order',
        description:
          'Customer confirmed a pending order (ok/hari/yes). Mark confirm-order tag / flow.',
        parameters: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
          },
        },
      },
    })
  }

  if (caps.tracking) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_tracking',
        description:
          "Send latest tracking info for this customer's recent order.",
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    })
  }

  tools.push({
    type: 'function',
    function: {
      name: 'handover_to_human',
      description:
        'Tag the chat Human and pause automation so a person can reply. Use for wholesale deals, complaints, angry customers, or when no tool can help safely.',
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

/** Allowed action names for Anthropic JSON fallback (includes legacy aliases). */
export const AGENT_TOOL_NAMES = [
  'identify_product',
  'create_order',
  'answer_delivery',
  'answer_policy',
  'ask_missing_information',
  'confirm_order',
  'send_tracking',
  'handover_to_human',
  // Legacy aliases — executors may no-op cart tools (pipeline owns those)
  'find_product',
  'generate_quote',
  'update_order',
  'send_quick_reply',
  'send_quotation',
  'edit_order',
  'mark_human',
] as const

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}
