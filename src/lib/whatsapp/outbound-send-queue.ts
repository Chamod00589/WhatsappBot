/**
 * Per-conversation outbound send queue.
 *
 * Meta's WhatsApp Cloud API accepts image `link` sends immediately, then
 * fetches URLs asynchronously — overlapping fetches for two Product QRs
 * mix images on the customer phone. All multi-image catalog / card sends
 * for one chat must finish (and settle) before the next starts.
 */

const chains = new Map<string, Promise<unknown>>()

export function enqueueConversationSend<T>(
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = conversationId.trim() || '_unknown'
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(task, task)
  chains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
