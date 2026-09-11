// components/preview-tab.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { ShieldWarning, LockSimple, Clock, FileDashed, Warning } from '@phosphor-icons/react'
import { classifyExtractionError } from '@/lib/classify-extraction-error'
import { getDomain } from '@/lib/get-domain'
import { Spinner } from './ui/spinner'

const ICONS = { ShieldWarning, LockSimple, Clock, FileDashed, Warning }
type PreviewMode = 'live' | 'screenshot' | 'mobile'

/**
 * Captures are full-page and enormous — a mean of 717kb, 120 of them over 1MB,
 * and the largest 8.7MB — because a full-page shot of a long site at 2× is a
 * genuinely huge picture. The panel used to hand the browser the original and
 * let it download all of it to show a column a few hundred pixels wide.
 *
 * Cards already went through the image optimizer; this is the same route. The
 * 8.7MB capture comes back at 1.2MB for a 1200px column, and smaller again in
 * AVIF where the browser accepts it.
 *
 * Only blob-hosted captures are optimizable — the optimizer is deliberately
 * restricted to that one host, so anything else is served as-is.
 */
const OPTIMIZABLE = '.public.blob.vercel-storage.com'
/**
 * q must be 75. Next 16 validates quality against `images.qualities`, which
 * defaults to [75], and anything else is a 400 INVALID_IMAGE_OPTIMIZE_REQUEST
 * — served as text/plain, so the panel would show a broken image rather than
 * an unoptimized one.
 */
function optimized(url: string, width: number): string {
  if (!url.includes(OPTIMIZABLE)) return url
  return `/_next/image?url=${encodeURIComponent(url)}&w=${width}&q=75`
}
/**
 * 640 and 1080 only. A full-page capture is tall enough that asking for 1200
 * or more puts the output over the optimizer's ceiling, and it answers with
 * the untouched original — 8.7MB for the largest capture, which is the whole
 * problem this is here to solve. At 1080 that same capture arrives as 639kb
 * of AVIF.
 */
const WIDTHS = [640, 1080]

interface PreviewTabProps {
  siteUrl: string
  screenshotUrl?: string | null
  mobileScreenshotUrl?: string | null
  extractionError?: string | null
  /**
   * False for the sites whose live preview can never work — six refuse a
   * server-side fetch outright (403, a bot gate, markdown served to
   * non-browsers) and eighteen ship an empty shell that only fills in once
   * their own JavaScript runs, which the proxy does not execute.
   *
   * Without this the panel spent eight seconds discovering that again on every
   * visit, then fell back to the screenshot it could have shown immediately.
   */
  livePreview?: boolean
  displayMode?: Extract<PreviewMode, 'live' | 'mobile'>
  /** Drop the drawn phone frame — on an actual phone it is a picture of the
   *  device you are holding, and it costs the preview most of its width. */
  fill?: boolean
}

export function PreviewTab({
  siteUrl,
  screenshotUrl,
  mobileScreenshotUrl,
  extractionError,
  livePreview = true,
  displayMode = 'live',
  fill = false,
}: PreviewTabProps) {
  const hasDesktop = Boolean(screenshotUrl)
  /** Where this site starts: its capture if live can never work, else live. */
  const openingMode: PreviewMode =
    !livePreview && displayMode === 'live' ? (hasDesktop ? 'screenshot' : 'mobile') : displayMode

  const [loaded, setLoaded] = useState(false)
  const [proxyFailed, setProxyFailed] = useState(false)
  const [mode, setMode] = useState<PreviewMode>(openingMode)
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const errorCheckTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const domain = getDomain(siteUrl)
  const proxyUrl = `/api/proxy?url=${encodeURIComponent(siteUrl)}&picker=0`
  const hasDesktopScreenshot = hasDesktop
  const hasMobileScreenshot = Boolean(mobileScreenshotUrl)
  const hasScreenshot = hasDesktopScreenshot || hasMobileScreenshot
  const activeScreenshotUrl =
    mode === 'mobile' ? mobileScreenshotUrl :
    mode === 'screenshot' ? screenshotUrl :
    null

  useEffect(() => {
    setLoaded(false)
    setProxyFailed(false)
    setMode(openingMode)
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current)
    errorCheckTimersRef.current.forEach(clearTimeout)
    errorCheckTimersRef.current = []
    // No timer where there is no live attempt to time out.
    if (openingMode !== 'screenshot') {
      loadTimerRef.current = setTimeout(() => setProxyFailed(true), 8000)
    }
    return () => {
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current)
      errorCheckTimersRef.current.forEach(clearTimeout)
      errorCheckTimersRef.current = []
    }
  }, [openingMode, siteUrl])

  useEffect(() => {
    if (!proxyFailed || !hasScreenshot || mode !== 'live') return
    setMode(hasDesktopScreenshot ? 'screenshot' : 'mobile')
  }, [hasDesktopScreenshot, hasScreenshot, mode, proxyFailed])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'proxy-failed') {
        if (loadTimerRef.current) clearTimeout(loadTimerRef.current)
        setProxyFailed(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  function detectRenderedPreviewError() {
    try {
      const text = iframeRef.current?.contentDocument?.body?.innerText ?? ''
      if (text.includes('Application error: a client-side exception has occurred')) {
        setProxyFailed(true)
      }
    } catch {
      // Cross-origin access should not happen because /api/proxy is same-origin,
      // but if a browser denies it, the normal timeout/error paths still apply.
    }
  }

  function handleLoad() {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current)
    setLoaded(true)
    errorCheckTimersRef.current.forEach(clearTimeout)
    errorCheckTimersRef.current = [250, 750, 1500, 3000].map(delay =>
      setTimeout(detectRenderedPreviewError, delay)
    )
  }

  if (extractionError && !siteUrl) {
    const info = classifyExtractionError(extractionError)
    const Icon = ICONS[info.icon]
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8">
        <div className="w-full rounded-[4px] border border-edge p-6 text-center space-y-3">
          <div className="flex items-center justify-center gap-2 text-ink-3">
            <Icon className="w-3.5 h-3.5" />
            <span className="text-micro">{info.label}</span>
          </div>
          <p className="text-bodytext text-ink-2 leading-relaxed">{info.explanation}</p>
        </div>
      </div>
    )
  }

  if (activeScreenshotUrl) {
    return (
      <div className="relative flex-1 min-h-0 overflow-auto bg-muted/35">
        <div className={`min-h-full ${fill ? 'p-0' : 'p-4'} ${mode === 'mobile' && !fill ? 'flex justify-center' : ''}`}>
          <img
            src={optimized(activeScreenshotUrl, 1080)}
            srcSet={WIDTHS.map(w => `${optimized(activeScreenshotUrl, w)} ${w}w`).join(', ')}
            sizes={mode === 'mobile' ? '390px' : '(max-width: 1279px) 100vw, 40vw'}
            decoding="async"
            alt={`${mode === 'mobile' ? 'Mobile' : 'Desktop'} screenshot of ${domain}`}
            className={`block rounded-[4px] border border-edge bg-background shadow-sm ${
              mode === 'mobile' ? 'w-full max-w-[390px]' : 'w-full'
            }`}
          />
        </div>
      </div>
    )
  }

  if (mode === 'mobile' && !proxyFailed && livePreview) {
    return (
      <div className="relative flex-1 min-h-0 overflow-hidden bg-muted/35">
        <div className={fill ? 'absolute inset-0' : 'absolute inset-4 flex justify-center'}>
          <div className={`relative h-full w-full overflow-hidden bg-background ${fill ? '' : 'max-w-[390px] rounded-[4px] border border-edge shadow-sm'}`}>
            {!loaded && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 pointer-events-none">
                <span className="text-meta text-ink-3">{domain}</span>
                <Spinner />
              </div>
            )}
            <iframe
              ref={iframeRef}
              key={`${proxyUrl}-mobile`}
              src={proxyUrl}
              title={`Mobile live preview of ${siteUrl}`}
              onLoad={handleLoad}
              onError={() => setProxyFailed(true)}
              sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
              className="h-full w-full border-none"
              style={{ opacity: loaded ? 1 : 0, transition: 'opacity var(--dur-4) var(--ease-sig)' }}
            />
          </div>
        </div>
      </div>
    )
  }

  if (proxyFailed) {
    return (
      <div className="relative flex flex-col items-center justify-center flex-1 gap-5">
        <div className="text-center space-y-1.5">
          <p className="text-meta text-ink-2">{domain}</p>
          <p className="text-micro text-ink-4">Live preview unavailable</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex-1 overflow-hidden min-h-0">
      {!loaded && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <span className="text-meta text-ink-3">{domain}</span>
          <Spinner />
        </div>
      )}
      <iframe
        ref={iframeRef}
        key={`${proxyUrl}-live`}
        src={proxyUrl}
        title={`Live preview of ${siteUrl}`}
        onLoad={handleLoad}
        onError={() => setProxyFailed(true)}
        sandbox="allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
        className="w-full h-full border-none"
        style={{ opacity: loaded ? 1 : 0, transition: 'opacity var(--dur-4) var(--ease-sig)' }}
      />
    </div>
  )
}
