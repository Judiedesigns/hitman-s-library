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
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await new Promise(r => setTimeout(r, 3500))

    const shares = await page.evaluate(measureColorAreaShares)
    const hexes = Object.keys(shares)
    if (!hexes.length) { skipped++; log(`  [${i + 1}/${queue.length}] ${site.id} nothing measurable`); continue }

    // Only colours the palette already holds. A share for a colour nobody
    // stored is not ours to add here.
    let touched = 0
    for (const [hex, share] of Object.entries(shares)) {
      const res = await sql.query(
        `UPDATE design_colors SET area_share = $1 WHERE source_id = $2 AND LOWER(hex_value) = $3`,
        [share, site.id, hex],
      )
      touched += res.length ?? 0
    }
    // Anything the palette holds that never appeared on screen still needs a
    // number, or it would draw as a full-width band next to a real one.
    await sql.query(
      `UPDATE design_colors SET area_share = 0 WHERE source_id = $1 AND area_share IS NULL`,
      [site.id],
    )
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
