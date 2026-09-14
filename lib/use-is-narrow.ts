'use client'

import { useEffect, useState } from 'react'

/** The breakpoint at which the panel stops being a sheet and becomes a column. */
const SHEET_QUERY = '(max-width: 1279px)'

/**
 * True below the three-pane split, where the detail panel is a sheet.
 *
 * The layout used to decide this in CSS alone, with both panels mounted and
 * one hidden. That is usually harmless and was not here: each panel holds a
 * live preview, so every site was being fetched and rendered twice, once into
 * a frame nobody could see. It also made failures cross over — the hidden copy
 * could report a preview dead and take the visible one with it.
 *
 * Starts false so the server render and the first client render agree, then
 * corrects on mount. The panel is never part of the first paint, so there is
 * nothing to flash.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const query = window.matchMedia(SHEET_QUERY)
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return narrow
}
