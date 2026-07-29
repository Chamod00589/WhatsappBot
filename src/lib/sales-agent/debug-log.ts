import type { SupabaseClient } from '@supabase/supabase-js'

export type SalesAgentRunStatus =
  | 'running'
  | 'skipped'
  | 'completed'
  | 'failed'

export interface SalesAgentDebugStep {
  at: string
  phase: string
  detail: string
  data?: unknown
}

export interface SalesAgentRunPayload {
  steps: SalesAgentDebugStep[]
  /** Compact chat context fed to the model (role + content). */
  ai_context?: Array<{ role: string; content: string }>
  use_singlish?: boolean
  reply_mode?: 'singlish' | 'tanglish'
  capabilities?: Record<string, boolean>
  product_hits?: Array<{ title: string; catalog_message_id: string | null }>
  custom_qr_match?: { title: string; score: number } | null
  identify?: unknown
  tools?: Array<{ name: string; arguments: unknown; result?: string }>
  reply?: { text?: string; handoff?: boolean; replied?: boolean }
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  } | null
  error?: string
}

/**
 * Mutable debug recorder for one Sales Agent dispatch.
 * Persist with finish() — never throws (troubleshoot must not break bot).
 */
export class SalesAgentRunLogger {
  private id: string | null = null
  private steps: SalesAgentDebugStep[] = []
  private payload: SalesAgentRunPayload = { steps: [] }
  private status: SalesAgentRunStatus = 'running'
  private skipReason: string | null = null

  constructor(
    private db: SupabaseClient,
    private meta: {
      accountId: string
      conversationId: string
      contactId: string
      inboundText: string
      contentType: string
    },
  ) {}

  step(phase: string, detail: string, data?: unknown): void {
    this.steps.push({
      at: new Date().toISOString(),
      phase,
      detail,
      ...(data !== undefined ? { data } : {}),
    })
    this.payload.steps = this.steps
  }

  set(partial: Partial<SalesAgentRunPayload>): void {
    Object.assign(this.payload, partial)
    this.payload.steps = this.steps
  }

  /** Create the DB row early so the inbox can show "running". */
  async start(): Promise<void> {
    try {
      const { data, error } = await this.db
        .from('sales_agent_runs')
        .insert({
          account_id: this.meta.accountId,
          conversation_id: this.meta.conversationId,
          contact_id: this.meta.contactId,
          inbound_text: this.meta.inboundText?.slice(0, 2000) || null,
          content_type: this.meta.contentType,
          status: 'running',
          payload: this.payload,
        })
        .select('id')
        .single()
      if (error) {
        console.warn('[sales-agent-debug] start insert failed:', error.message)
        return
      }
      this.id = data.id as string
    } catch (err) {
      console.warn('[sales-agent-debug] start failed:', err)
    }
  }

  async skip(reason: string, detail?: string): Promise<void> {
    this.status = 'skipped'
    this.skipReason = reason
    this.step('gate', detail || reason, { reason })
    await this.persist()
  }

  async fail(err: unknown): Promise<void> {
    this.status = 'failed'
    const message = err instanceof Error ? err.message : String(err)
    this.payload.error = message
    this.step('error', message)
    await this.persist()
  }

  async complete(): Promise<void> {
    this.status = 'completed'
    await this.persist()
  }

  private async persist(): Promise<void> {
    this.payload.steps = this.steps
    try {
      if (!this.id) {
        // start() failed earlier — try a one-shot insert
        await this.db.from('sales_agent_runs').insert({
          account_id: this.meta.accountId,
          conversation_id: this.meta.conversationId,
          contact_id: this.meta.contactId,
          inbound_text: this.meta.inboundText?.slice(0, 2000) || null,
          content_type: this.meta.contentType,
          status: this.status,
          skip_reason: this.skipReason,
          payload: this.payload,
          finished_at: new Date().toISOString(),
        })
        return
      }
      await this.db
        .from('sales_agent_runs')
        .update({
          status: this.status,
          skip_reason: this.skipReason,
          payload: this.payload,
          finished_at: new Date().toISOString(),
        })
        .eq('id', this.id)
    } catch (err) {
      console.warn('[sales-agent-debug] persist failed:', err)
    }
  }
}
