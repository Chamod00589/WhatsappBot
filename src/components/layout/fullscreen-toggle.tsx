'use client'

import { useCallback, useEffect, useState } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

/**
 * Enter / exit browser fullscreen (hides URL bar when the browser allows it).
 * Placed next to the light/dark mode toggle in the app header.
 */
export function FullscreenToggle({ className }: { className?: string }) {
  const t = useTranslations('FullscreenToggle')
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await document.documentElement.requestFullscreen()
      }
    } catch {
      /* Browser blocked fullscreen (e.g. not a user gesture) — ignore */
    }
  }, [])

  const label = isFullscreen ? t('exit') : t('enter')

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {isFullscreen ? (
        <Minimize2 className="h-5 w-5" />
      ) : (
        <Maximize2 className="h-5 w-5" />
      )}
    </button>
  )
}
