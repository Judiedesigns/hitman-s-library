// components/colors-tab.tsx
'use client'

import { useState } from 'react'
import { Check } from '@phosphor-icons/react'
import { useSoundsContext } from '@/contexts/sounds-context'
import { TabEmptyState } from './tab-empty-state'
import { useCopied } from '@/lib/use-copied'

interface ColorRow {
  hex_value: string
  oklch: string | null
  /** Share of the page's painted area, 0..1. Null on rows extracted before it
   *  was measured, in which case the palette falls back to equal bands. */
  area_share: number | null
}

function parseOklch(s: string): { l: number; c: number; h: number } | null {
  const m = s.match(/oklch\(\s*([\d.]+)\s+([\d.e+\-]+)\s+([\d.]+|none)/)
  if (!m) return null
  return {
    l: Math.round(parseFloat(m[1]) * 100),
    c: parseFloat(m[2]),
    h: m[3] === 'none' ? 0 : Math.round(parseFloat(m[3])),
  }
}

function lightness(c: ColorRow): number {
  return c.oklch ? parseFloat(c.oklch.match(/oklch\(([\d.]+)/)?.[1] ?? '0.5') : 0.5
}

/** Readable text on a given band, judged by the band's own lightness. */
function inkOn(c: ColorRow): string {
  return lightness(c) > 0.62 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.86)'
}

/**
 * Every band is legible and no band swamps the panel. A site whose background
 * is 94% of its painted area is the normal case, not the exception, and drawn
 * literally it leaves eight colours sharing a sliver.
 */
const MIN_BAND = 34
const MAX_BAND = 132

export function ColorsTab({ colors, extractionError }: { colors: ColorRow[]; extractionError?: string | null }) {
  const [format, setFormat] = useState<'hex' | 'oklch'>('hex')
  const rowCopy = useCopied()
  const exportCopy = useCopied()
  const { playCopy } = useSoundsContext()

  if (!colors.length) {
    return <TabEmptyState message="No colors extracted" extractionError={extractionError} />
  }

  // Darkest to lightest. A palette sorted by usage jumps around the spectrum
  // and stops reading as a palette; sorted by lightness it reads as one object
  // and the proportions still show in the band heights.
  const sorted = [...colors].sort((a, b) => lightness(a) - lightness(b))
  const measured = sorted.some(c => typeof c.area_share === 'number')
  const total = sorted.reduce((sum, c) => sum + (c.area_share ?? 0), 0)

  function bandHeight(c: ColorRow): number {
    if (!measured || total <= 0) return 60
    const share = (c.area_share ?? 0) / total
    return Math.round(MIN_BAND + share * (MAX_BAND - MIN_BAND))
  }

  function valueOf(c: ColorRow): string {
    const parsed = c.oklch ? parseOklch(c.oklch) : null
    return format === 'oklch' && parsed
      ? `oklch(${parsed.l}% ${parsed.c.toFixed(2)} ${parsed.h}°)`
      : c.hex_value
  }

  function buildCssVars(): string {
    return sorted.map((c, i) => `  --color-${i + 1}: ${c.hex_value};`).join('\n')
  }

  function buildTailwind(): string {
    const entries = sorted.map((c, i) => `      '${i + 1}': '${c.hex_value}',`).join('\n')
    return `extend: {\n  colors: {\n    brand: {\n${entries}\n    },\n  },\n}`
  }

  async function copy(text: string, mark: () => void) {
    try {
      await navigator.clipboard.writeText(text)
      playCopy()
      mark()
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">

      <div className="sticky top-0 bg-background border-b border-edge px-4 py-2 flex items-center justify-between gap-2 shrink-0 z-10">
        <div className="flex items-center gap-px">
          {(['hex', 'oklch'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFormat(f)}
              className={[
                'px-2 py-0.5 rounded-[4px] text-micro transition-colors',
                format === f ? 'bg-foreground text-background' : 'text-ink-4 hover:text-ink-2',
              ].join(' ')}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-px">
          {(['css', 'tailwind'] as const).map(type => (
            <button
              key={type}
              onClick={() => copy(
                type === 'css' ? `:root {\n${buildCssVars()}\n}` : buildTailwind(),
                () => exportCopy.markCopied(type),
              )}
              className={[
                'w-9 py-0.5 rounded-[4px] text-micro flex items-center justify-center transition-colors',
                exportCopy.copiedId === type ? 'text-ink' : 'text-ink-4 hover:text-ink-2',
              ].join(' ')}
            >
              {exportCopy.copiedId === type
                ? <Check className="w-3 h-3" weight="bold" />
                : (type === 'css' ? 'CSS' : 'TW')}
            </button>
          ))}
          <span className="text-meta text-ink-4 ml-1 tabular-nums">{colors.length}</span>
        </div>
      </div>

      {/* One object, not a list of rows: the bands meet with no gap and the
          palette is read as a whole, the way it is on the site itself. */}
      <div className="p-3">
        <div className="overflow-hidden rounded-[5px] border border-edge">
          {sorted.map((color, i) => {
            const value = valueOf(color)
            const copied = rowCopy.copiedId === i
            const share = measured && total > 0 ? (color.area_share ?? 0) / total : null
            return (
              <button
                key={`${color.hex_value}-${i}`}
                onClick={() => copy(value, () => rowCopy.markCopied(i))}
                title={`Copy ${value}`}
                style={{ background: color.hex_value, height: bandHeight(color), color: inkOn(color) }}
                className="group relative w-full flex items-center justify-between px-3.5 text-left transition-[filter] duration-[var(--dur-2)] ease-[var(--ease-sig)] hover:brightness-[1.06] focus-visible:outline-none focus-visible:brightness-[1.06]"
              >
                <span className="text-meta tabular-nums opacity-90">{value}</span>
                <span className="flex items-center gap-2.5">
                  {share !== null && share >= 0.01 && (
                    <span className="text-micro tabular-nums opacity-55">
                      {Math.round(share * 100)}%
                    </span>
                  )}
                  <span className={[
                    'text-micro transition-opacity duration-150',
                    copied ? 'opacity-90' : 'opacity-0 group-hover:opacity-70',
                  ].join(' ')}>
                    {copied ? 'copied' : 'copy'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        {!measured && (
          <p className="text-micro text-ink-4 mt-2.5 px-0.5">
            Shown at equal weight — this site&rsquo;s colours were read before coverage was measured.
          </p>
        )}
      </div>
    </div>
  )
}
