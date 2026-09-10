// Checks that every capture in the library is fetchable and actually shows the
// page. A URL stored in the row proves nothing: a capture can 404, or come back
// as a single flat colour because the site never painted before the shutter.
import { neon } from '@neondatabase/serverless'
import sharp from 'sharp'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))

/** A capture whose pixels barely vary is a blank page, whatever its file size. */
async function inspect(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
  const buf = Buffer.from(await res.arrayBuffer())
  const img = sharp(buf)
  const { width, height } = await img.metadata()
  const stats = await img.stats()
  // Standard deviation across channels, averaged. A solid fill sits near 0.
  const spread = stats.channels.reduce((sum, c) => sum + c.stdev, 0) / stats.channels.length
  if (spread < 3) return { ok: false, why: `flat image (σ=${spread.toFixed(1)})`, width, height }
  if (height < 200) return { ok: false, why: `too short (${width}×${height})`, width, height }
  return { ok: true, width, height, spread: Number(spread.toFixed(1)), bytes: buf.length }
}

const rows = await sql.query(
  'SELECT id, source_url, screenshot_url, mobile_screenshot_url FROM design_sources ORDER BY id')
const bad = []
let checked = 0

async function check(row) {
  for (const [which, url] of [['desktop', row.screenshot_url], ['mobile', row.mobile_screenshot_url]]) {
    if (!url) { bad.push({ id: row.id, which, why: 'missing', url: row.source_url }); continue }
    try {
      const r = await inspect(url)
      if (!r.ok) bad.push({ id: row.id, which, why: r.why, url: row.source_url })
    } catch (e) {
      bad.push({ id: row.id, which, why: String(e).slice(0, 80), url: row.source_url })
    }
  }
  checked++
  if (checked % 25 === 0) process.stderr.write(`\r${checked}/${rows.length}`)
}

const queue = [...rows]
await Promise.all(Array.from({ length: 8 }, async () => { while (queue.length) await check(queue.shift()) }))
fs.writeFileSync('capture-problems.json', JSON.stringify(bad, null, 1))
console.log(`\nchecked ${rows.length} sites (${rows.length * 2} captures)`)
console.log(`problems: ${bad.length}`)
const byWhy = {}
for (const b of bad) byWhy[b.why.replace(/σ=[\d.]+/, 'σ')] = (byWhy[b.why.replace(/σ=[\d.]+/, 'σ')] || 0) + 1
console.log(Object.entries(byWhy).map(([w, n]) => `  ${n}× ${w}`).join('\n'))
