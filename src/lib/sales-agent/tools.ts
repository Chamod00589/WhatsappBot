import type { AiConfigWithSales } from './types'

type ToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const lineItemSchema = {
  type: 'object',
  properties: {
    productId: { type: 'string' },
    name: { type: 'string', description: 'Bag / product name' },
    color: { type: 'string' },
    quantity: { type: 'number' },
    price: {
      type: 'number',
      description: 'Optional — server fills catalog price when omitted or 0',
    },
  },
  required: ['name'],
} as const

/**
 * OpenAI-compatible tools for the LLM-first Sales Agent.
 * The model decides intent; these tools only execute side effects.
 */
export function buildSalesAgentTools(caps: AiConfigWithSales): ToolDef[] {
  const tools: ToolDef[] = []

  if (caps.identify) {
    tools.push({
      type: 'function',
      function: {
        name: 'identify_product',
        description:
          'Identify bag(s) in the customer inbound image(s) via CLIP catalog matching. Catalog supports same-color variants (Pink.webp + Pink__2.webp) and product-only shots (_1.webp). Returns product, color (empty if unknown), confidence. If color is empty / color_unknown is set, ask which color — never invent one. Set send_product_card=true to send the product quick-reply when confidence is high. When cards are sent successfully, the server may auto-send a quotation (quotation_sent=true) — do not call generate_quote again in that case.',
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
          'Find a catalog bag by name (or id) and send its product quick-reply card with photos/details. Call when the customer names a bag or after identify confirms a product. Can be called multiple times for multiple bags.',
        parameters: {
          type: 'object',
          properties: {
            product_name: {
              type: 'string',
              description: 'Bag name as the customer said it, e.g. "Cloudy", "Bunny Bag"',
            },
            product_id: { type: 'string' },
            catalog_message_id: { type: 'string' },
            quick_reply_id: { type: 'string' },
            color: {
              type: 'string',
              description: 'Remembered color for later order/quote if known',
            },
            quantity: {
              type: 'number',
              description: 'How many pieces (e.g. 2 from \"2k\" / 1 from \"1i\")',
            },
          },
        },
      },
    })
  }

  if (caps.quotation) {
    tools.push({
      type: 'function',
      function: {
        name: 'generate_quote',
        description:
          'Send a price quotation (screenshot/card) for the selected bags. Use when the customer asks price / how much / kochchara / quotation, or after find_product when they want a total. Prefer items from the conversation; if items omitted, uses bags already saved in this chat. Skip if identify_product already returned quotation_sent=true this turn. After the first quote in a chat, the server auto-sends Address Quick Reply once (no address caption on the quote image).',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: lineItemSchema,
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
          'Create a ladiesbags order when the customer provided delivery name/address/phone AND bag name + color (+ qty). Pass the raw address message. If items omitted, uses bags saved from earlier quote/identify in this chat.',
        parameters: {
          type: 'object',
          properties: {
            address_text: {
              type: 'string',
              description: 'Raw customer message with name, address, phone',
            },
            items: {
              type: 'array',
              items: lineItemSchema,
            },
          },
          required: ['address_text'],
        },
      },
    })
  }

  if (caps.editOrder) {
    tools.push({
      type: 'function',
      function: {
        name: 'update_order',
        description:
          'Update bag/color/qty for this chat. If an order already exists: merge/replace items (mode=add|replace) or change color, then re-send the order confirm screenshot. If NO order yet: update the last quotation memory the same way and re-send the quotation screenshot; if no quotation exists yet, send a new quotation with the requested bags/colors. For ADD ("ekakuth" / "dekakuth" / "thawa"), pass only the NEW bag(s) with mode=add and the NEW color — existing quoted colors stay. Same bag in two colors = two lines (e.g. White x1 + Black x2).',
        parameters: {
          type: 'object',
          properties: {
            order_id: {
              type: 'string',
              description: 'Order UUID if known; otherwise latest order for this phone is used',
            },
            mode: {
              type: 'string',
              enum: ['add', 'replace'],
              description:
                'add = append/merge new bags onto existing order (default). replace = overwrite entire items list.',
            },
            color: {
              type: 'string',
              description: 'New color for line items when that is the only change',
            },
            target_name: {
              type: 'string',
              description: 'Which bag to recolor when multiple items exist',
            },
            patch: {
              type: 'object',
              description: 'Advanced patch object for the orders API (address/notes)',
            },
            items: {
              type: 'array',
              items: lineItemSchema,
              description:
                'Bags to add (mode=add) or full cart (mode=replace). For add, only include the new bag(s).',
            },
          },
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
              description: 'Required: id of the best matching FAQ from the list',
            },
            catalog_message_id: {
              type: 'string',
              description: 'Optional catalog message id if listed',
            },
            reason: {
              type: 'string',
              description: 'Short why this FAQ matches the customer ask',
            },
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
              description: 'Required: id of the best matching FAQ from the list',
            },
            catalog_message_id: {
              type: 'string',
              description: 'Optional catalog message id if listed',
            },
            reason: {
              type: 'string',
              description: 'Short why this FAQ matches',
            },
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
        'Send a short clarifying WhatsApp message when something required is missing (which bag, color, qty, address, phone). Use Singlish/Tanglish per language rules. Do not invent prices or policies here — use generate_quote / answer_* tools instead.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Short customer-facing question (1–2 sentences)',
          },
        },
        required: ['message'],
      },
    },
  })

  tools.push({
    type: 'function',
    function: {
      name: 'confirm_order',
      description:
        'When the customer confirms a pending order (ok / yes / hari) and the contact has Pending tag, move Pending → Confirmed and send the confirmation reply.',
      parameters: {
        type: 'object',
        properties: {
          customer_text: {
            type: 'string',
            description: 'The confirmation message from the customer',
          },
        },
      },
    },
  })

  if (caps.tracking) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_tracking',
        description: 'Send tracking info for the customer’s latest order.',
        parameters: { type: 'object', properties: {} },
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
  'find_product',
  'generate_quote',
  'create_order',
  'update_order',
  'answer_delivery',
  'answer_policy',
  'ask_missing_information',
  'confirm_order',
  'send_tracking',
  'handover_to_human',
  // Legacy aliases (older prompts / cached models)
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
