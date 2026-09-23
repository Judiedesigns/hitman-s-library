// Removes the sites that do not preview, after writing every row they own to a
// restore file. Run with --dry to see the plan without touching the database.
//
// The list comes from preview-recheck.mjs, which tests one site at a time: the
// parallel audit that preceded it reported a quarter more failures than were
// real, because eight concurrent headless tabs starve each other. Removal reads
// from the serial run only.
import { neon } from '@neondatabase/serverless'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))
const dry = process.argv.includes('--dry')

const confirmed = JSON.parse(fs.readFileSync('preview-confirmed.json', 'utf8'))
const ids = confirmed.map(r => r.id)

// Everything below design_sources cascades on delete, so the parent row alone
// would be enough to remove a site — and not nearly enough to put it back.
const CHILDREN = [
  'design_patterns', 'design_colors', 'design_typography',
  'design_styles', 'design_embeddings', 'design_assets',
]

const sources = await sql.query(
  `SELECT * FROM design_sources WHERE id = ANY($1) ORDER BY id`, [ids],
)
if (sources.length !== ids.length) {
  const found = new Set(sources.map(r => r.id))
  console.error(`expected ${ids.length} rows, found ${sources.length}: missing ${ids.filter(i => !found.has(i))}`)
  process.exit(1)
}

const backup = { removedAt: new Date().toISOString(), reasons: confirmed, design_sources: sources }
for (const table of CHILDREN) {
  try {
    backup[table] = await sql.query(`SELECT * FROM ${table} WHERE source_id = ANY($1)`, [ids])
  } catch (e) {
    // A table from an earlier migration that this database never got.
    if (!/does not exist/.test(e.message)) throw e
    console.log(`skipping ${table}: not in this database`)
  }
}

const counts = Object.entries(backup)
  .filter(([, v]) => Array.isArray(v) && v !== confirmed)
  .map(([k, v]) => `${k} ${v.length}`)
console.log(counts.join(', '))

const file = `removed-sites-${new Date().toISOString().slice(0, 10)}.json`
fs.writeFileSync(file, JSON.stringify(backup, null, 1))
console.log(`wrote ${file}`)

if (dry) {
  for (const s of sources) console.log(`  would remove ${s.id} ${s.source_name} — ${s.source_url}`)
  process.exit(0)
}

const removed = await sql.query(`DELETE FROM design_sources WHERE id = ANY($1) RETURNING id, source_name`, [ids])
console.log(`removed ${removed.length} sites`)
const [{ count }] = await sql`SELECT COUNT(*)::int as count FROM design_sources`
console.log(`${count} sites remain`)
