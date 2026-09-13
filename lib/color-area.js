/**
 * Runs inside the page. Returns how much of it each colour covers, as a share
 * of all measured background area, keyed by lowercase hex.
 *
 * Plain JavaScript and self-contained on purpose: it is handed to
 * page.evaluate, which serialises the function and runs it in the browser, so
 * it can close over nothing. Kept in its own module because both the live
 * extractor and the backfill script need exactly this, and two copies of a
 * measurement is two measurements.
 */
export function measureColorAreaShares() {
  function toHex(value) {
    if (!value) return null
    const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/)
    if (!m) return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null
    // A colour you can see through is a scrim, not part of the palette.
    if (m[4] !== undefined && parseFloat(m[4]) < 0.9) return null
    const h = n => Math.round(parseFloat(n)).toString(16).padStart(2, '0')
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`.toLowerCase()
  }

  const areaByHex = new Map()
  let total = 0

  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 1200)) {
    const hex = toHex(getComputedStyle(el).backgroundColor)
    if (!hex) continue
    const r = el.getBoundingClientRect()
    const area = r.width * r.height
    // Below this it is a border, a chip or a dot — real, but not a share of
    // the page in any sense a reader would recognise.
    if (area < 2500) continue
    areaByHex.set(hex, (areaByHex.get(hex) || 0) + area)
    total += area
  }

  // The body's own background is the page, and it is almost never an element
  // in that list. Without it every site reads as though its accents cover far
  // more ground than they do.
  const bodyHex = toHex(getComputedStyle(document.body).backgroundColor)
  if (bodyHex) {
    const pageArea = Math.max(document.body.scrollWidth, 1) * Math.max(document.body.scrollHeight, 1)
    areaByHex.set(bodyHex, (areaByHex.get(bodyHex) || 0) + pageArea)
    total += pageArea
  }

  const out = {}
  if (!total) return out
  for (const [hex, area] of areaByHex) out[hex] = area / total
  return out
}
