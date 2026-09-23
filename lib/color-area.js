/**
 * Runs inside the page. Returns how much of it each colour accounts for, as a
 * share of everything measured, keyed by lowercase hex.
 *
 * Plain JavaScript and self-contained on purpose: it is handed to
 * page.evaluate, which serialises the function and runs it in the browser, so
 * it can close over nothing. Kept in its own module because both the extractor
 * and the backfill script need exactly this, and two copies of a measurement
 * are two measurements.
 *
 * Counts two things, because counting only one produced a useless answer. A
 * first cut measured background area alone and added the body's background at
 * full scroll height: every site came back as one colour at 100% and the rest
 * at nothing, which is true of a page and says nothing about a palette. Type
 * is where most of a palette's colours actually live.
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

  const area = new Map()
  const add = (hex, amount) => { if (hex && amount > 0) area.set(hex, (area.get(hex) || 0) + amount) }

  // The page itself, at one viewport. Counting its full scroll height instead
  // makes the background so large that nothing else registers.
  const view = window.innerWidth * window.innerHeight
  add(toHex(getComputedStyle(document.body).backgroundColor), view)

  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 1500)) {
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue

    const box = r.width * r.height
    // Below this it is a border, a chip or a dot — real, but not a share of
    // the page in any sense a reader would recognise.
    if (box >= 2500) add(toHex(style.backgroundColor), box)

    // Ink, not the box the ink sits in. A heading in the brand colour covers a
    // fraction of its own bounding box, and charging it the whole box would
    // make every text colour outrank every background.
    const own = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .join('')
    if (own.length) {
      const size = parseFloat(style.fontSize) || 16
      // Roughly: each glyph inks about a third of its em square.
      add(toHex(style.color), own.length * size * size * 0.33)
    }
  }

  let total = 0
  for (const value of area.values()) total += value
  const out = {}
  if (!total) return out
  for (const [hex, value] of area) out[hex] = value / total
  return out
}
