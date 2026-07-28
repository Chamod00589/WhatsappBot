/** Shared order / quotation constants (match Tampermonkey WhatsApp script). */

export const QUOTATION_SHIPPING_LKR = 400
export const DUPLICATE_ORDER_DAYS = 3

export const ORDER_STATUS_LABELS: Record<string, string> = {
  web_order: 'Web Order',
  chatbot: 'ChatBot',
  pending: 'Pending',
  hold: 'Hold',
  confirmed: 'Confirmed',
  half_payment: 'Half payment',
  full_payment: 'Full payment',
  ready_for_shipping: 'Ready for shipping',
  shipped: 'Shipped',
  completed: 'Completed',
  cancelled: 'Cancelled',
  return: 'Return',
}

/** Status values agents can set when editing an order from the inbox. */
export const ORDER_STATUS_OPTIONS = Object.keys(ORDER_STATUS_LABELS)

export const SHIPPING_METHOD_OPTIONS = [
  { value: 'courier', label: 'Courier' },
  { value: 'speed_post', label: 'Post office / Speed Post' },
  { value: 'store_pickup', label: 'Store pickup' },
] as const

export type OrderPaymentStatus = 'pending' | 'half_payment' | 'full_payment'

export function formatOrderLabelBarcode(orderId: string | null | undefined): string {
  const hex = String(orderId || '')
    .replace(/-/g, '')
    .slice(0, 8)
    .toUpperCase()
  return 'LB' + hex
}

export function orderShippingShortLabel(method: string | null | undefined): string {
  if (method === 'speed_post') return 'Speed Post'
  if (method === 'store_pickup') return 'Store pickup'
  return 'Courier'
}

export function formatLkr(amount: number): string {
  const n = Number.isFinite(amount) ? amount : 0
  return `LKR ${n.toLocaleString('en-LK')}.00`
}

export function formatOrderMoney(n: number): string {
  return formatLkr(n)
}

export function buildOrderScreenshotCaption(
  order: { id?: string; total_amount?: number | string | null },
  siteBase: string,
): string {
  const total = Math.round(Number(order.total_amount) || 0)
  const trackId = formatOrderLabelBarcode(order.id)
  const base = siteBase.replace(/\/$/, '')
  const trackUrl = `${base}/tracking/${encodeURIComponent(trackId)}`
  return [
    `මුලු මුදල = Rs ${total.toLocaleString('en-LK')}/=`,
    '',
    'වැඩකරන දින 2-3 ඇතුලත පාර්සලේ හම්බෙනවා dr.',
    `පාර්සලයේ බෙදාහැරීමේ තොරතුරු මෙතනින් බලන්න පුලුවන්: ${trackUrl}`,
    '',
    'ඕඩර් එකේ විස්තර හරි නේද ? (බෑග් එකේ පාටයි, ලිපිනයයි)',
    '',
    'ஆர்டரின் விவரங்கள் சரியாக உள்ளதா? (பையின் நிறம், முகவரி)',
  ].join('\n')
}

/** Same Gemini prompt as the Tampermonkey Create Order flow. */
export function geminiAddressPrompt(text: string): string {
  return `Extract the customer's delivery details from the message below. Reply using EXACTLY this format — no markdown, no commentary, no blank lines:

@@Customer name
@@Address line 1,
Address line 2,
...
Last address line (no trailing comma)
@@Phone 1
@@Phone 2

RULES

Name:
- Sinhala name → romanize to standard English (e.g. "දිල්හාර සෙව්වන්දි" → "Dilhara sewwandi").
- English name → copy exactly, preserving original casing (e.g. "W.G. Janani thathsarani").

Address:
- Only the first line gets "@@"; every other part is a separate plain line below it.
- Split on natural breaks (usually commas): house/street, lane/road, area, city — one part per line.
- Every line except the last ends with a trailing comma.
- Capitalize each line properly, even if the source was lowercase/ALL CAPS.
- Sinhala place/street names → romanize to standard Sri Lankan shipping-label English (e.g. "පන්සල පාර" → "Temple Road"). Keep numbers as-is (e.g. "370/1").
- If a place/city is mentioned twice (e.g. once inline, once repeated as confirmation on its own line), include it only ONCE — never repeat a line back-to-back.

Structured "📌" input (Name / Address / District / Contact):
- Map 📌Name → name, 📌Address → address, 📌Contact 01 → Phone 1, 📌Contact 02 → Phone 2. Keep phone digits exactly as given.
- If 📌District is given and isn't already in the address lines, append it as the final address line.

Phone:
- Phone 1 and Phone 2 must be Sri Lankan mobiles: exactly 10 digits starting with 0 (e.g. 0771234567). Strip +94 / spaces; never include country code in the @@ phone lines.
- Include @@Phone 2 only if a second number actually appears; otherwise omit it entirely.

General:
- Never invent or guess missing information.

EXAMPLES

Input:
📌Name:දිල්හාර සෙව්වන්දි
📌Address:370/1 පන්සල පාර,මාගස්වත්ත,යටියන ,අගලවත්ත
📌District:kaluthara
📌Contact 01:0750134866
📌Contact 02:0712709791

Output:
@@Dilhara sewwandi
@@370/1 Temple Road,
Magaswatta,
Yatiyana,
Agalawaththa,
Kaluthara
@@0750134866
@@0712709791

Input (free-form, city repeated):
"...Ampara junction, chanaka motars , siyambalanduwa ... Siyambalanduwa"

Output:
@@Ampara junction,
Chanaka motars,
Siyambalanduwa

Input (free-form, English name kept as-is):
"...Faculty of Fisheries and Marine Sciences and Technology, University of Ruhuna, Wallamadama, Matara... K.N.C. Peiris, 0770415911"

Output:
@@K.N.C. Peiris
@@Faculty of Fisheries and Marine Sciences and Technology,
University of Ruhuna,
Wallamadama,
Matara
@@0770415911

Message:
"""
${text}
"""`
}

export function normalizeSlMobile10(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return ''
  let n = digits
  if (n.startsWith('94') && n.length >= 11) n = '0' + n.slice(2)
  else if (n.length === 9) n = '0' + n
  if (n.length > 10 && n.startsWith('0')) n = n.slice(0, 10)
  return /^0\d{9}$/.test(n) ? n : ''
}

/** Normalize phone lines inside an @@ order block (match Tampermonkey). */
export function normalizeOrderTextMobilePhones(text: string): string {
  if (!text || !text.includes('@@')) return text
  const chunks = text
    .split('@@')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!chunks.length) return text
  const productIdx = chunks.findIndex((c) => c.includes('::'))
  const normalized = chunks.map((chunk, i) => {
    if (i === productIdx) return chunk
    if (i < 2) return chunk
    const lines = chunk.split('\n')
    const firstLine = (lines[0] || '').trim()
    if (!/[\d]/.test(firstLine)) return chunk
    const n = normalizeSlMobile10(firstLine)
    if (!n) return chunk
    lines[0] = n
    return lines.join('\n')
  })
  return '@@' + normalized.join('\n@@')
}

/**
 * Collect Phone 1 / Phone 2 from an @@ order block, plus any other SL mobiles
 * found in the address text — used for duplicate-order checks.
 */
export function extractPhonesFromOrderText(text: string): string[] {
  const found: string[] = []
  const add = (raw: string) => {
    const n = normalizeSlMobile10(raw)
    if (n && !found.includes(n)) found.push(n)
  }

  if (text.includes('@@')) {
    const chunks = text
      .split('@@')
      .map((s) => s.trim())
      .filter(Boolean)
    const productIdx = chunks.findIndex((c) => c.includes('::'))
    const fieldChunks =
      productIdx >= 0 ? chunks.filter((_, i) => i !== productIdx) : chunks
    // Phone fields start at index 2 (name, address, phone1, phone2…)
    for (let i = 2; i < fieldChunks.length; i++) {
      const firstLine = (fieldChunks[i] || '').split('\n')[0] || ''
      add(firstLine)
    }
    // Also scan address (and whole text) for embedded mobiles.
    for (const chunk of fieldChunks) {
      const matches = chunk.match(/0\d{9}|\+94\d{9}|94\d{9}/g) || []
      for (const m of matches) add(m)
    }
  } else {
    const matches = text.match(/0\d{9}|\+94\d{9}|94\d{9}/g) || []
    for (const m of matches) add(m)
  }

  return found
}

export interface OrderLineItem {
  /** Catalog product id — required when patching order line items. */
  productId?: string
  name: string
  color: string
  qty: number
  price: number
  image?: string
}

/** Append or replace the trailing @@Name::Color::Qty product chunk. */
export function buildOrderTextWithProducts(
  baseText: string,
  items: OrderLineItem[],
): string {
  if (!items.length) return baseText.trim()
  const stripped = stripProductChunk(baseText).trim()
  const chunk = items
    .map((it) => `${it.name}::${it.color || ''}::${Math.max(1, it.qty || 1)}`)
    .join(';')
  if (!stripped) return `@@${chunk}`
  return `${stripped}\n@@${chunk}`
}

function stripProductChunk(text: string): string {
  if (!text || !text.includes('@@')) return text
  const chunks = text
    .split('@@')
    .map((s) => s.trim())
    .filter(Boolean)
  const kept = chunks.filter((c) => !c.includes('::'))
  if (!kept.length) return ''
  return '@@' + kept.join('\n@@')
}
