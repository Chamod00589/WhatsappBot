'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
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
    last_phase?: string
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
              No Sales Agent runs yet for this chat. Use Clear agent history
              (eraser next to Delete) or send{' '}
              <code className="rounded bg-muted px-1">***</code>, then a new
              message to test.
            </p>
          ) : (
            <ul className="space-y-2">
              {runs.map((run) => {
                const isOpen = expanded === run.id
                const aiContextAll = formatAiContext(run.payload.ai_context)
                const toolsAll = formatTools(run.payload.tools)
                const stepsAll = formatSteps(run.payload.steps)
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
                          {run.status === 'running' ? (
                            <span className="text-amber-700 dark:text-amber-300">
                              {formatElapsed(run.created_at)}
                              {run.payload.last_phase
                                ? ` · ${run.payload.last_phase}`
                                : ''}
                            </span>
                          ) : null}
                          <span className="text-muted-foreground">
                            {run.content_type || '—'}
                          </span>
                          {run.skip_reason ? (
                            <span className="truncate text-amber-700 dark:text-amber-300">
                              skip: {run.skip_reason}
                            </span>
                          ) : null}
                        </div>
                        {run.status === 'running' &&
                        (run.payload.steps?.length ?? 0) > 0 ? (
                          <p className="mt-0.5 truncate text-sky-700 dark:text-sky-300">
                            Last:{' '}
                            {run.payload.steps![run.payload.steps!.length - 1]
                              ?.detail || run.payload.last_phase}
                          </p>
                        ) : null}
                        {run.inbound_text ? (
                          <p className="mt-0.5 truncate text-foreground/80">
                            “{run.inbound_text}”
                          </p>
                        ) : null}
                      </div>
                    </button>

                    {isOpen ? (
                      <div className="space-y-3 border-t border-border px-2.5 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <CopyButton
                            text={formatCompleteRun(run)}
                            label="Copy complete run"
                          />
                          <span className="text-[10px] text-muted-foreground">
                            Paste into chat for troubleshooting
                          </span>
                        </div>

                        {run.status === 'running' ? (
                          <p className="rounded bg-amber-500/10 px-2 py-1 text-amber-800 dark:text-amber-200">
                            Still running
                            {run.payload.last_phase
                              ? ` — phase: ${run.payload.last_phase}`
                              : ''}
                            {` (${formatElapsed(run.created_at)})`}. Steps
                            update live every few seconds.
                            {(run.payload.steps?.length ?? 0) === 0
                              ? ' Waiting for first progress flush…'
                              : ''}
                          </p>
                        ) : null}

                        {run.inbound_text ? (
                          <Section
                            title="Inbound"
                            copyAllText={run.inbound_text}
                          >
                            <CopyableBlock text={run.inbound_text} />
                          </Section>
                        ) : null}

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
                          <Section
                            title="Capabilities"
                            copyAllText={JSON.stringify(
                              run.payload.capabilities,
                              null,
                              2,
                            )}
                          >
                            <CopyableBlock
                              text={JSON.stringify(
                                run.payload.capabilities,
                                null,
                                2,
                              )}
                            />
                          </Section>
                        ) : null}

                        {run.payload.ai_context?.length ? (
                          <Section
                            title="AI context passed (compact)"
                            copyAllText={aiContextAll}
                            copyAllLabel="Copy all msgs"
                          >
                            <ul className="space-y-1">
                              {run.payload.ai_context.map((m, i) => (
                                <li key={i}>
                                  <CopyableBlock
                                    label={m.role}
                                    text={m.content}
                                  />
                                </li>
                              ))}
                            </ul>
                          </Section>
                        ) : null}

                        {run.payload.product_hits?.length ? (
                          <Section
                            title="Product matches"
                            copyAllText={run.payload.product_hits
                              .map(
                                (h) =>
                                  `${h.title}${h.catalog_message_id ? ` (${h.catalog_message_id})` : ''}`,
                              )
                              .join('\n')}
                          >
                            <CopyableBlock
                              text={run.payload.product_hits
                                .map(
                                  (h) =>
                                    `${h.title}${h.catalog_message_id ? ` (${h.catalog_message_id})` : ''}`,
                                )
                                .join('\n')}
                            />
                          </Section>
                        ) : null}

                        {run.payload.custom_qr_match ? (
                          <Meta
                            label="Custom QR"
                            value={`${run.payload.custom_qr_match.title} · score ${run.payload.custom_qr_match.score.toFixed(2)}`}
                          />
                        ) : null}

                        {run.payload.tools?.length ? (
                          <Section
                            title="Tool calls"
                            copyAllText={toolsAll}
                            copyAllLabel="Copy all tools"
                          >
                            <ul className="space-y-1">
                              {run.payload.tools.map((t, i) => {
                                const block = [
                                  t.name,
                                  `args: ${safeJson(t.arguments)}`,
                                  t.result ? `result: ${t.result}` : '',
                                ]
                                  .filter(Boolean)
                                  .join('\n')
                                return (
                                  <li key={i}>
                                    <CopyableBlock
                                      label={t.name}
                                      text={block}
                                    />
                                  </li>
                                )
                              })}
                            </ul>
                          </Section>
                        ) : null}

                        {run.payload.reply ? (
                          <Section
                            title="Reply / outcome"
                            copyAllText={JSON.stringify(
                              run.payload.reply,
                              null,
                              2,
                            )}
                          >
                            <CopyableBlock
                              text={JSON.stringify(run.payload.reply, null, 2)}
                            />
                          </Section>
                        ) : null}

                        {run.payload.usage ? (
                          <Meta
                            label="Tokens"
                            value={`prompt ${run.payload.usage.promptTokens ?? '—'} · completion ${run.payload.usage.completionTokens ?? '—'} · total ${run.payload.usage.totalTokens ?? '—'}`}
                          />
                        ) : null}

                        {run.payload.error ? (
                          <Section
                            title="Error"
                            copyAllText={run.payload.error}
                          >
                            <CopyableBlock text={run.payload.error} />
                          </Section>
                        ) : null}

                        <Section
                          title="Process steps"
                          copyAllText={stepsAll}
                          copyAllLabel="Copy all steps"
                        >
                          <ol className="space-y-1.5 border-l-2 border-border pl-3">
                            {(run.payload.steps ?? []).map((s, i) => {
                              const stepText = [
                                `[${s.phase}] ${s.detail}`,
                                s.data !== undefined ? safeJson(s.data) : '',
                              ]
                                .filter(Boolean)
                                .join('\n')
                              return (
                                <li key={i}>
                                  <div className="flex flex-wrap items-center gap-x-2">
                                    <span className="font-semibold text-foreground">
                                      {s.phase}
                                    </span>
                                    <span className="text-muted-foreground">
                                      {formatTime(s.at)}
                                    </span>
                                    <CopyButton text={stepText} />
                                  </div>
                                  <p className="select-text text-foreground/90">
                                    {s.detail}
                                  </p>
                                  {s.data !== undefined ? (
                                    <CopyableBlock
                                      text={safeJson(s.data)}
                                      className="mt-0.5"
                                    />
                                  ) : null}
                                </li>
                              )
                            })}
                          </ol>
                        </Section>

                        <details className="text-muted-foreground">
                          <summary className="cursor-pointer select-none">
                            Raw payload JSON
                          </summary>
                          <CopyableBlock
                            className="mt-1 max-h-40"
                            text={JSON.stringify(run.payload, null, 2)}
                          />
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

function formatAiContext(
  msgs: Array<{ role: string; content: string }> | undefined,
): string {
  if (!msgs?.length) return ''
  return msgs
    .map((m) => `${m.role.toUpperCase()}\n${m.content}`)
    .join('\n\n')
}

function formatTools(
  tools: Array<{ name: string; arguments: unknown; result?: string }> | undefined,
): string {
  if (!tools?.length) return ''
  return tools
    .map((t) =>
      [
        t.name,
        `args: ${safeJson(t.arguments)}`,
        t.result ? `result: ${t.result}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n---\n\n')
}

function formatSteps(
  steps: Array<{
    at: string
    phase: string
    detail: string
    data?: unknown
  }> | undefined,
): string {
  if (!steps?.length) return ''
  return steps
    .map((s) =>
      [
        `[${s.phase}] ${formatTime(s.at)}`,
        s.detail,
        s.data !== undefined ? safeJson(s.data) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n')
}

function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  const onCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] transition-colors',
        copied
          ? 'text-emerald-700 dark:text-emerald-300'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {copied ? (
        <Check className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  )
}

function CopyableBlock({
  text,
  label,
  className,
}: {
  text: string
  label?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'group relative rounded bg-muted/60 px-2 py-1 font-mono text-[10px]',
        className,
      )}
    >
      <div className="mb-0.5 flex items-center justify-between gap-2">
        {label ? (
          <span className="font-semibold uppercase text-muted-foreground">
            {label}
          </span>
        ) : (
          <span />
        )}
        <CopyButton text={text} />
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all select-text leading-relaxed">
        {text}
      </pre>
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
  copyAllText,
  copyAllLabel = 'Copy all',
}: {
  title: string
  children: React.ReactNode
  copyAllText?: string
  copyAllLabel?: string
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="font-medium text-foreground">{title}</p>
        {copyAllText ? (
          <CopyButton text={copyAllText} label={copyAllLabel} />
        ) : null}
      </div>
      {children}
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="font-medium text-foreground">{label}: </span>
      <span className="select-text text-foreground/80">{value}</span>
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

function formatElapsed(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(ms) || ms < 0) return '…'
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m ${s % 60}s`
  } catch {
    return '…'
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** One pasteable dump: inbound + caps + steps + identify + tools + reply. */
function formatCompleteRun(run: RunRow): string {
  const p = run.payload || {}
  const parts: string[] = [
    `status: ${run.status}`,
    `at: ${run.created_at}`,
    `content_type: ${run.content_type || '—'}`,
    run.skip_reason ? `skip_reason: ${run.skip_reason}` : '',
    '',
    '=== Inbound ===',
    run.inbound_text || '(no text)',
    '',
    `Language: ${p.use_singlish ? 'Singlish' : 'Match customer'}`,
  ]

  if (p.capabilities) {
    parts.push('', '=== Capabilities ===', safeJson(p.capabilities))
  }
  if (p.ai_context?.length) {
    parts.push('', '=== AI context ===', formatAiContext(p.ai_context))
  }
  if (p.identify != null) {
    parts.push('', '=== Identify ===', safeJson(p.identify))
  }
  if (p.product_hits?.length) {
    parts.push(
      '',
      '=== Product hits ===',
      p.product_hits
        .map((h) => `${h.title} (${h.catalog_message_id || '—'})`)
        .join('\n'),
    )
  }
  if (p.custom_qr_match) {
    parts.push('', '=== Custom QR ===', safeJson(p.custom_qr_match))
  }
  if (p.tools?.length) {
    parts.push('', '=== Tools ===', formatTools(p.tools))
  }
  if (p.reply) {
    parts.push('', '=== Reply ===', safeJson(p.reply))
  }
  if (p.usage) {
    parts.push('', '=== Tokens ===', safeJson(p.usage))
  }
  if (p.error) {
    parts.push('', '=== Error ===', p.error)
  }
  if (p.steps?.length) {
    parts.push('', '=== Process steps ===', formatSteps(p.steps))
  }
  parts.push('', '=== Raw payload ===', safeJson(p))
  return parts.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n')
}

