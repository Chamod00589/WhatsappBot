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
  /** Last phase label for the inbox while status=running. */
  last_phase?: string
}

/**
 * Mutable debug recorder for one Sales Agent dispatch.
 * Flushes steps to DB while running so the inbox can show live progress.
 * Persist helpers never throw (troubleshoot must not break bot).
 */
export class SalesAgentRunLogger {
  private id: string | null = null
  private steps: SalesAgentDebugStep[] = []
  private payload: SalesAgentRunPayload = { steps: [] }
  private status: SalesAgentRunStatus = 'running'
  private skipReason: string | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushInFlight: Promise<void> | null = null
  private flushQueued = false

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
    this.payload.last_phase = phase
    this.scheduleFlush()
  }

  set(partial: Partial<SalesAgentRunPayload>): void {
    Object.assign(this.payload, partial)
    this.payload.steps = this.steps
    this.scheduleFlush()
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
    await this.persistFinal()
  }

  async fail(err: unknown): Promise<void> {
    if (this.status === 'completed' || this.status === 'skipped') return
    this.status = 'failed'
    const message = err instanceof Error ? err.message : String(err)
    this.payload.error = message
    this.step('error', message)
    await this.persistFinal()
  }

  async complete(): Promise<void> {
    // Prefer completed even if the watchdog already marked hung/failed.
    this.status = 'completed'
    await this.persistFinal()
  }

  /** Force a progress write (e.g. right after identify QR). */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.status === 'running') {
      await this.flushProgress()
    }
  }

  /** Debounced mid-run flush (keeps finished_at null). */
  private scheduleFlush(): void {
    if (this.status !== 'running') return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flushProgress()
    }, 250)
  }

  private async flushProgress(): Promise<void> {
    if (this.status !== 'running') return
    if (this.flushInFlight) {
      this.flushQueued = true
      return
    }
    this.flushInFlight = this.persist({ finished: false }).finally(() => {
      this.flushInFlight = null
      if (this.flushQueued) {
        this.flushQueued = false
        void this.flushProgress()
      }
    })
    await this.flushInFlight
  }

  private async persistFinal(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.flushInFlight) {
      try {
        await this.flushInFlight
      } catch {
        /* ignore */
      }
    }
    await this.persist({ finished: true })
  }

  private async persist(opts: { finished: boolean }): Promise<void> {
    this.payload.steps = this.steps
    try {
      if (!this.id) {
        if (!opts.finished) return
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
      const patch: Record<string, unknown> = {
        status: this.status,
        skip_reason: this.skipReason,
        payload: this.payload,
      }
      if (opts.finished) {
        patch.finished_at = new Date().toISOString()
      }
      await this.db.from('sales_agent_runs').update(patch).eq('id', this.id)
    } catch (err) {
      console.warn('[sales-agent-debug] persist failed:', err)
    }
  }
}
