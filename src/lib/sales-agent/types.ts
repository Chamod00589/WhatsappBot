import type { AiConfig } from '@/lib/ai/types'

/** Sales Agent capability flags (stored on ai_configs). */
export interface SalesAgentCapabilities {
  salesAgentEnabled: boolean
  productMatch: boolean
  identify: boolean
  customQrMatch: boolean
  aiText: boolean
  createOrder: boolean
  quotation: boolean
  tracking: boolean
  editOrder: boolean
}

export const DEFAULT_SALES_AGENT_CAPABILITIES: SalesAgentCapabilities = {
  salesAgentEnabled: true,
  productMatch: true,
  identify: true,
  customQrMatch: true,
  aiText: true,
  createOrder: true,
  quotation: true,
  tracking: true,
  editOrder: true,
}

export type AiConfigWithSales = AiConfig & SalesAgentCapabilities

export interface SalesAgentDispatchArgs {
  accountId: string
  conversationId: string
  contactId: string
  configOwnerUserId: string
  /** Fresh inbound text (may be empty for image-only). */
  inboundText: string
  /** Content type of the triggering inbound message. */
  contentType: string
  /** Public media URL when the inbound was an image (may be auth proxy). */
  mediaUrl?: string | null
  /** Meta media id for inbound images — preferred for identify download. */
  metaMediaId?: string | null
  /** True when this is the contact's first-ever inbound. */
  isFirstInboundMessage?: boolean
}

export interface IdentifyPendingState {
  product: string
  color: string
  confidence: number
  catalogMessageId?: string | null
  quickReplyId?: string | null
  askedAt: string
}

export const IDENTIFY_CONFIDENCE_THRESHOLD = 90
export const SALES_AGENT_CONTEXT_LIMIT = 15
export const TEST_MARKER = '***'

/** Short blurbs stored on outbound messages for compact AI context. */
export const CONTEXT_BLURBS = {
  orderConfirm: 'order confirm msg include order data',
  tracking: 'tracking info msg include latest order tracking status',
  quotation: 'quotation msg include selected bags prices and shipping',
  identifyConfirm: 'asked customer to confirm identified bag match',
} as const
