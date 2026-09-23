// Fills design_colors.area_share for rows extracted before the column existed.
//
// Deliberately narrow: it visits each site, measures how much of the page each
// colour covers, and writes that one number onto colours already stored. It
// never inserts, deletes or rewrites a colour. Re-running the full extractor
// would have done the job and would also have replaced good palettes and
// typography with whatever today's render produced — too much risk for one
// number.
//
// Run with --ids 1,2,3 to redo specific sites, --limit N to take a bite.
import { neon } from '@neondatabase/serverless'
import puppeteer from 'puppeteer'
import fs from 'fs'
import { measureColorAreaShares } from '../lib/color-area.js'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))
const arg = n => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1] }
const only = arg('--ids')?.split(',').map(Number)
const limit = Number(arg('--limit')) || null

const log = m => { console.log(m); fs.appendFileSync('color-shares.log', m + '\n') }

/**
 * Straight-line distance in RGB. Not perceptually uniform, and it does not
 * need to be — the only question is whether two near-identical renderings of
 * the same colour should be treated as one, and at this range every colour
 * space agrees.
 */
function rgbDistance(a, b) {
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
  const [r1, g1, b1] = rgb(a)
  const [r2, g2, b2] = rgb(b)
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)
}

/** Roughly 28 per channel — the width of "the same colour, repainted". */
const MAX_DISTANCE = 48

const sites = only
  ? await sql`SELECT id, source_url AS url FROM design_sources WHERE id = ANY(${only}) ORDER BY id`
  : await sql`
      SELECT DISTINCT s.id, s.source_url AS url
      FROM design_sources s
      JOIN design_colors c ON c.source_id = s.id
      WHERE c.area_share IS NULL
      ORDER BY s.id`

const queue = limit ? sites.slice(0, limit) : sites
log(`measuring colour shares for ${queue.length} sites`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

let updated = 0, skipped = 0
for (const [i, site] of queue.entries()) {
  const page = await browser.newPage()
  try {
    // Headless Chrome reports prefers-color-scheme: dark, and a theme-aware
    // site then paints a palette that has nothing to do with the one stored
    // against it — deck.gallery measured as #0f0f0f and #1b1b1b against a
    // stored palette of black, white, blue and grey. This is the same trap
    // that once made a capture-comparison audit report 90% of the library
    // broken. Ask for light, which is what the extractor saw.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await new Promise(r => setTimeout(r, 3500))

    const shares = await page.evaluate(measureColorAreaShares)
    const hexes = Object.keys(shares)
    if (!hexes.length) { skipped++; log(`  [${i + 1}/${queue.length}] ${site.id} nothing measurable`); continue }

    const stored = await sql.query(
      `SELECT id, LOWER(hex_value) AS hex FROM design_colors WHERE source_id = $1`, [site.id],
    )
    if (!stored.length) { skipped++; continue }

    // Attribute each measured colour to the nearest one the palette holds.
    // An exact match is the exception: a page repaints #fdfdfc where the
    // palette recorded #ffffff, and refusing to see those as the same colour
    // throws away almost every measurement. Anything with no near neighbour
    // is a colour the palette does not claim, and is dropped rather than
    // forced onto whichever entry happens to be least far away.
    const byId = new Map(stored.map(r => [r.id, 0]))
    for (const [hex, share] of Object.entries(shares)) {
      let best = null, bestDistance = Infinity
      for (const row of stored) {
        const d = rgbDistance(hex, row.hex)
        if (d < bestDistance) { bestDistance = d; best = row.id }
      }
      if (best === null || bestDistance > MAX_DISTANCE) continue
      byId.set(best, byId.get(best) + share)
    }

    const total = [...byId.values()].reduce((a, b) => a + b, 0)
    for (const [rowId, share] of byId) {
      await sql.query(
        `UPDATE design_colors SET area_share = $1 WHERE id = $2`,
        [total > 0 ? share / total : 0, rowId],
      )
    }
    updated++
    if ((i + 1) % 10 === 0 || i === 0) log(`  [${i + 1}/${queue.length}] ${site.id} ${hexes.length} measured`)
  } catch (e) {
    skipped++
    log(`  [${i + 1}/${queue.length}] ${site.id} failed: ${String(e.message || e).slice(0, 70)}`)
  } finally {
    await page.close().catch(() => {})
  }
}

await browser.close()
log(`${updated} sites measured, ${skipped} skipped`)
