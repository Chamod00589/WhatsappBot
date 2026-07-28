'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Bug,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface RunRow {
  id: string
  status: string
  skip_reason: string | null
  inbound_text: string | null
  content_type: string | null
  payload: {
    steps?: Array<{
      at: string
      phase: string
      detail: string
      data?: unknown
    }>
    ai_context?: Array<{ role: string; content: string }>
    use_singlish?: boolean
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
  created_at: string
  finished_at: string | null
}

interface SalesAgentDebugPanelProps {
  conversationId: string
}

/**
 * Inbox troubleshoot panel: shows Sales Agent background steps, AI context,
 * tool calls, and reply data for the open chat.
 */
export function SalesAgentDebugPanel({
  conversationId,
}: SalesAgentDebugPanelProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/sales-agent/runs?conversationId=${encodeURIComponent(conversationId)}&limit=8`,
        { cache: 'no-store' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || `HTTP ${res.status}`)
        setRuns([])
        return
      }
      const next = (data.runs as RunRow[]) ?? []
      setRuns(next)
      setExpanded((prev) => prev ?? next[0]?.id ?? null)
    } catch {
      setError('Network error loading debug runs')
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    setRuns([])
    setExpanded(null)
    setError(null)
    if (open) void load()
  }, [conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    void load()
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [open, load])

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
            open
              ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Bug className="h-3.5 w-3.5" />
          {open ? 'Hide AI debug' : 'AI debug'}
        </button>
        {open ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="max-h-72 overflow-y-auto border-t border-border bg-muted/30 px-3 py-2 text-xs sm:px-4">
          {error ? (
            <p className="text-destructive">{error}</p>
          ) : runs.length === 0 && !loading ? (
            <p className="text-muted-foreground">
              No Sales Agent runs yet for this chat. Send a test message (or{' '}
              <code className="rounded bg-muted px-1">***</code> then a
              message) to see steps here.
            </p>
          ) : (
            <ul className="space-y-2">
              {runs.map((run) => {
                const isOpen = expanded === run.id
                return (
                  <li
                    key={run.id}
                    className="rounded-md border border-border bg-card"
                  >
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
                      onClick={() =>
                        setExpanded((id) => (id === run.id ? null : run.id))
                      }
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill status={run.status} />
                          <span className="text-muted-foreground">
                            {formatTime(run.created_at)}
                          </span>
                          <span className="text-muted-foreground">
                            {run.content_type || '—'}
                          </span>
                          {run.skip_reason ? (
                            <span className="truncate text-amber-700 dark:text-amber-300">
                              skip: {run.skip_reason}
                            </span>
                          ) : null}
                        </div>
                        {run.inbound_text ? (
                          <p className="mt-0.5 truncate text-foreground/80">
                            “{run.inbound_text}”
                          </p>
                        ) : null}
                      </div>
                    </button>

                    {isOpen ? (
                      <div className="space-y-3 border-t border-border px-2.5 py-2">
                        {run.payload.use_singlish != null ? (
                          <Meta
                            label="Language"
                            value={
                              run.payload.use_singlish
                                ? 'Singlish'
                                : 'Match customer'
                            }
                          />
                        ) : null}

                        {run.payload.capabilities ? (
                          <Section title="Capabilities">
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                              {JSON.stringify(run.payload.capabilities, null, 2)}
                            </pre>
                          </Section>
                        ) : null}

                        {run.payload.ai_context?.length ? (
                          <Section title="AI context passed (compact)">
                            <ul className="space-y-1">
                              {run.payload.ai_context.map((m, i) => (
                                <li
                                  key={i}
                                  className="rounded bg-muted/60 px-2 py-1 font-mono text-[10px]"
                                >
                                  <span className="font-semibold uppercase text-muted-foreground">
                                    {m.role}
                                  </span>
                                  <span className="ml-2 whitespace-pre-wrap wrap-break-word">
                                    {m.content}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </Section>
                        ) : null}

                        {run.payload.product_hits?.length ? (
                          <Section title="Product matches">
                            <ul className="list-inside list-disc">
                              {run.payload.product_hits.map((h, i) => (
                                <li key={i}>
                                  {h.title}
                                  {h.catalog_message_id
                                    ? ` (${h.catalog_message_id})`
                                    : ''}
                                </li>
                              ))}
                            </ul>
                          </Section>
                        ) : null}

                        {run.payload.custom_qr_match ? (
                          <Meta
                            label="Custom QR"
                            value={`${run.payload.custom_qr_match.title} · score ${run.payload.custom_qr_match.score.toFixed(2)}`}
                          />
                        ) : null}

                        {run.payload.tools?.length ? (
                          <Section title="Tool calls">
                            <ul className="space-y-1">
                              {run.payload.tools.map((t, i) => (
                                <li
                                  key={i}
                                  className="rounded bg-muted/60 px-2 py-1 font-mono text-[10px]"
                                >
                                  <div className="font-semibold">{t.name}</div>
                                  <div className="text-muted-foreground">
                                    args: {safeJson(t.arguments)}
                                  </div>
                                  {t.result ? (
                                    <div>result: {t.result}</div>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </Section>
                        ) : null}

                        {run.payload.reply ? (
                          <Section title="Reply / outcome">
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[10px] leading-relaxed">
                              {JSON.stringify(run.payload.reply, null, 2)}
                            </pre>
                          </Section>
                        ) : null}

                        {run.payload.usage ? (
                          <Meta
                            label="Tokens"
                            value={`prompt ${run.payload.usage.promptTokens ?? '—'} · completion ${run.payload.usage.completionTokens ?? '—'} · total ${run.payload.usage.totalTokens ?? '—'}`}
                          />
                        ) : null}

                        {run.payload.error ? (
                          <p className="text-destructive">{run.payload.error}</p>
                        ) : null}

                        <Section title="Process steps">
                          <ol className="space-y-1.5 border-l-2 border-border pl-3">
                            {(run.payload.steps ?? []).map((s, i) => (
                              <li key={i}>
                                <div className="flex flex-wrap gap-x-2">
                                  <span className="font-semibold text-foreground">
                                    {s.phase}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {formatTime(s.at)}
                                  </span>
                                </div>
                                <p className="text-foreground/90">{s.detail}</p>
                                {s.data !== undefined ? (
                                  <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 font-mono text-[10px] text-muted-foreground">
                                    {safeJson(s.data)}
                                  </pre>
                                ) : null}
                              </li>
                            ))}
                          </ol>
                        </Section>

                        <details className="text-muted-foreground">
                          <summary className="cursor-pointer select-none">
                            Raw payload JSON
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[10px]">
                            {JSON.stringify(run.payload, null, 2)}
                          </pre>
                        </details>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          {open ? (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              <X className="h-3 w-3" />
              Close
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'completed'
      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
      : status === 'skipped'
        ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
        : status === 'failed'
          ? 'bg-red-500/15 text-red-800 dark:text-red-200'
          : 'bg-sky-500/15 text-sky-800 dark:text-sky-200'
  return (
    <span className={cn('rounded px-1.5 py-0.5 font-medium uppercase', tone)}>
      {status}
    </span>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 font-medium text-foreground">{title}</p>
      {children}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="font-medium text-foreground">{label}: </span>
      <span className="text-foreground/80">{value}</span>
    </p>
  )
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
