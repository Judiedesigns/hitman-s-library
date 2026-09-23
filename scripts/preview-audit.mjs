// Does a site actually preview?
//
// Judged the way a person judges it: load the site through the real /api/proxy
// in a real browser, wait the budget the panel waits, and look at what is on
// screen. Three ways it can fail, and a status code tells you none of them:
// nothing painted at all, the browser's own "this page couldn't load", or a
// bot-check standing where the site should be.
//
// An earlier version of this compared the render against the site's stored
// capture and reported that 90% of the library was broken. It was comparing
// brightness: headless Chrome reports prefers-color-scheme: dark, so any
// theme-aware site renders dark here while its capture is light. deck.gallery
// previews perfectly and scored 212 out of 255 "different". The lesson is in
// the metric, not the library — judge the render on its own terms.
import { neon } from '@neondatabase/serverless'
import puppeteer from 'puppeteer'
import sharp from 'sharp'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))
const BASE = process.env.BASE_URL || 'https://hitmanslibrary.xyz'
const VIEW = { width: 1280, height: 800 }
const SETTLE_MS = 8000
/** Below this the viewport is a flat wall — nothing painted at all. */
const MIN_SPREAD = 4

/** What a browser or a bot-check puts on screen in place of the site. */
const FAILURE_TEXT = [
  "this page couldn't load",
  'this page couldn’t load',
  'application error: a client-side exception',
  'just a moment',
  'attention required',
  'access denied',
  'error 1015',
  'are you a robot',
  'verify you are human',
  'enable javascript to run this app',
  '403 forbidden',
  '404 not found',
  'this site can’t be reached',
]

const log = m => { console.log(m); fs.appendFileSync('preview-audit.log', m + '\n') }

async function audit(browser, row) {
  const page = await browser.newPage()
  const started = Date.now()
  try {
    await page.setViewport(VIEW)
    const proxy = `${BASE}/api/proxy?url=${encodeURIComponent(row.source_url)}&picker=0`
    await page.goto(proxy, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const painted = Date.now() - started
    await new Promise(r => setTimeout(r, SETTLE_MS))

    const seen = await page.evaluate(() => ({
      text: (document.body?.innerText || '').trim(),
      imgs: [...document.images].filter(i => i.naturalWidth > 0).length,
      canvas: document.querySelectorAll('canvas, svg, video').length,
    }))
    const shot = await page.screenshot({ type: 'png' })
    const st = await sharp(shot).stats()
    const spread = st.channels.reduce((s, c) => s + c.stdev, 0) / st.channels.length

    const lower = seen.text.toLowerCase()
    const hit = FAILURE_TEXT.find(f => lower.includes(f))
    const substance = seen.text.length >= 100 || seen.imgs >= 2 || seen.canvas >= 1

    const why =
      spread < MIN_SPREAD ? `nothing painted (spread ${spread.toFixed(1)})` :
      hit ? `error page: "${hit}"` :
      !substance ? `painted, but empty (${seen.text.length} chars, ${seen.imgs} images)` :
      null

    return { id: row.id, url: row.source_url, kind: row.kind, ok: !why, ms: painted, why,
             spread: Number(spread.toFixed(1)), chars: seen.text.length, imgs: seen.imgs }
  } catch (e) {
    return { id: row.id, url: row.source_url, kind: row.kind, ok: false,
             ms: Date.now() - started, why: String(e).slice(0, 80) }
  } finally { await page.close().catch(() => {}) }
}

const only = process.argv.includes('--ids')
  ? process.argv[process.argv.indexOf('--ids') + 1].split(',').map(Number) : null
const rows = only
  ? await sql.query('select id, source_name, source_url, kind from design_sources where id = ANY($1) order by id', [only])
  : await sql.query('select id, source_name, source_url, kind from design_sources order by id')

log(`auditing ${rows.length} previews against ${BASE}`)
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const results = []
const queue = [...rows]
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const r = await audit(browser, queue.shift())
    results.push(r)
    if (!r.ok) log(`FAIL ${r.id} ${r.url} — ${r.why}`)
    if (results.length % 25 === 0) log(`--- ${results.length}/${rows.length} ---`)
  }
}))
await browser.close()

fs.writeFileSync('preview-results.json', JSON.stringify(results, null, 1))
const bad = results.filter(r => !r.ok)
const ms = results.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b)
log(`\n${results.length - bad.length}/${results.length} preview`)
log(`time to first paint  p50 ${ms[Math.floor(ms.length/2)]}ms  p90 ${ms[Math.floor(ms.length*0.9)]}ms`)
