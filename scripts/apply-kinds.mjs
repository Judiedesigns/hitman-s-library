// Writes the approved kind for every site, and removes the sites whose domains
// no longer resolve. Run with --dry to print what it would do and touch nothing.
import { neon } from '@neondatabase/serverless'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))
const kinds = JSON.parse(fs.readFileSync(new URL('./kinds.json', import.meta.url), 'utf8'))
const dry = process.argv.includes('--dry')

// Domains that stopped resolving — SERVFAIL and NXDOMAIN respectively. There is
// no page left to screenshot, so there is nothing to show in the library.
const DEAD = [108, 264]

// Live sites the proxy can never render: six refuse a server-side fetch, and
// eighteen serve an empty shell that only fills in once their own JS runs.
// The panel opens straight to the capture for these instead of spending eight
// seconds discovering it again on every visit.
const NO_LIVE_PREVIEW = [
  5, 16, 24, 28, 51, 331,
  60, 62, 72, 73, 76, 82, 144, 165, 189, 233, 265, 270, 299, 308, 314, 334, 335, 337,
]

// A live domain whose captured page 404s. The site itself is fine, so retarget
// rather than remove.
const RETARGET = { 92: 'https://www.bitemark.studio/' }

const byKind = {}
for (const k of Object.values(kinds)) byKind[k] = (byKind[k] || 0) + 1
console.log('kinds:', Object.entries(byKind).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k} ${n}`).join(', '))
console.log(`removing ${DEAD.length}, retargeting ${Object.keys(RETARGET).length}, marking ${NO_LIVE_PREVIEW.length} screenshot-only`)
if (dry) { console.log('\n--dry: nothing written'); process.exit(0) }

let written = 0
for (const [id, kind] of Object.entries(kinds)) {
  await sql.query('UPDATE design_sources SET kind = $1 WHERE id = $2', [kind, Number(id)])
  written++
}
console.log(`kind written for ${written} sites`)

for (const [id, url] of Object.entries(RETARGET)) {
  await sql.query('UPDATE design_sources SET source_url = $1 WHERE id = $2', [url, Number(id)])
  console.log(`retargeted ${id} → ${url}`)
}

// metadata is jsonb; merge rather than replace so nothing else in it is lost.
for (const id of NO_LIVE_PREVIEW) {
  await sql.query(
    `UPDATE design_sources SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"live_preview": false}'::jsonb WHERE id = $1`,
    [id])
}
console.log(`marked ${NO_LIVE_PREVIEW.length} sites screenshot-only`)

for (const id of DEAD) {
  const [row] = await sql.query('SELECT source_url FROM design_sources WHERE id = $1', [id])
  await sql.query('DELETE FROM design_colors WHERE source_id = $1', [id])
  await sql.query('DELETE FROM design_typography WHERE source_id = $1', [id])
  await sql.query('DELETE FROM design_sources WHERE id = $1', [id])
  console.log(`removed ${id} ${row?.source_url ?? ''}`)
}

const [{ total, sorted }] = await sql.query(
  'SELECT COUNT(*) total, COUNT(kind) sorted FROM design_sources')
console.log(`done. ${sorted}/${total} sites filed`)
