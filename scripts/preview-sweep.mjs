// Does every site preview live, at every breakpoint the panel offers?
//
// The panel shows the same proxied document at both sizes, so a site can pass
// at 1440 and fail at 390 only by responding badly to a narrow viewport — which
// is exactly the kind of failure a desktop-only audit hides.
//
// Two phases, because neither alone is trustworthy. The sweep runs a few tabs
// at once, which is fast and over-reports: heavy pages loading together starve
// each other and Chrome blames the site. Everything it flags is then re-tested
// alone, three attempts, and only a failure that survives that counts. On the
// run this script was written for, ten of forty-one flagged sites rendered
// perfectly once they had a browser to themselves.
import { neon } from '@neondatabase/serverless'
import puppeteer from 'puppeteer'
import sharp from 'sharp'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))
const BASE = process.env.BASE_URL || 'https://hitmanslibrary.xyz'

/** The two the panel actually renders: the phone frame, and the desktop pane. */
const BREAKPOINTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
]
const SETTLE_MS = 8000
/** Below this the viewport is a flat wall — nothing painted at all. */
const MIN_SPREAD = 4
const LANES = 3

const FAILURE_TEXT = [
  "this page couldn't load", 'this page couldn’t load',
  'application error: a client-side exception', 'just a moment',
  'attention required', 'access denied', 'error 1015', 'are you a robot',
  'verify you are human', 'enable javascript to run this app',
  '403 forbidden', '404 not found', 'this site can’t be reached',
]

const log = m => { console.log(m); fs.appendFileSync('preview-sweep.log', m + '\n') }

async function judge(browser, url, bp, settle) {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: bp.width, height: bp.height })
    await page.goto(`${BASE}/api/proxy?url=${encodeURIComponent(url)}`,
      { waitUntil: 'domcontentloaded', timeout: 45000 })
    await new Promise(r => setTimeout(r, settle))
    const seen = await page.evaluate(() => ({
      text: (document.body?.innerText || '').trim(),
      imgs: [...document.images].filter(i => i.naturalWidth > 0).length,
      canvas: document.querySelectorAll('canvas, svg, video').length,
    }))
    const st = await sharp(await page.screenshot({ type: 'png' })).stats()
    const spread = st.channels.reduce((a, c) => a + c.stdev, 0) / st.channels.length
    const lower = seen.text.toLowerCase()
    const hit = FAILURE_TEXT.find(f => lower.includes(f))
    // A canvas or an SVG is a rendered page even with no prose in it — an
    // earlier cut of this required text and failed every WebGL site in the
    // library on the strength of it.
    const substance = seen.text.length >= 100 || seen.imgs >= 2 || seen.canvas >= 1
    return {
      ok: spread >= MIN_SPREAD && !hit && substance,
      why: spread < MIN_SPREAD ? `nothing painted (spread ${spread.toFixed(1)})`
         : hit ? `error page: "${hit}"`
         : !substance ? `painted, but empty (${seen.text.length} chars)` : null,
    }
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 90) }
  } finally {
    await page.close().catch(() => {})
  }
}

const sites = await sql`
  SELECT id, source_url as url, source_name as name, kind
  FROM design_sources ORDER BY id`
log(`sweeping ${sites.length} sites at ${BREAKPOINTS.map(b => b.width).join(' and ')}`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

// Phase one: fast and generous with suspicion.
const flagged = []
let cursor = 0
let done = 0
await Promise.all(Array.from({ length: LANES }, async () => {
  while (cursor < sites.length) {
    const s = sites[cursor++]
    const bad = []
    for (const bp of BREAKPOINTS) {
      const v = await judge(browser, s.url, bp, SETTLE_MS)
      if (!v.ok) bad.push(`${bp.name}: ${v.why}`)
    }
    if (bad.length) flagged.push({ ...s, bad })
    if (++done % 25 === 0) log(`  ${done}/${sites.length} swept, ${flagged.length} flagged`)
  }
}))
log(`phase one: ${flagged.length} flagged of ${sites.length}`)
fs.writeFileSync('sweep-flagged.json', JSON.stringify(flagged, null, 1))

// Phase two: alone, patient, three chances per breakpoint.
const confirmed = []
for (const [i, s] of flagged.entries()) {
  const bad = []
  for (const bp of BREAKPOINTS) {
    let v = null
    for (let attempt = 1; attempt <= 3 && !v?.ok; attempt++) {
      v = await judge(browser, s.url, bp, SETTLE_MS + 4000)
    }
    if (!v.ok) bad.push(`${bp.name}: ${v.why}`)
  }
  if (bad.length) {
    confirmed.push({ id: s.id, url: s.url, name: s.name, why: bad.join('; ') })
    log(`  [${i + 1}/${flagged.length}] ${s.id} FAILS — ${bad.join('; ')}`)
  } else {
    log(`  [${i + 1}/${flagged.length}] ${s.id} recovered alone`)
  }
  fs.writeFileSync('preview-confirmed.json', JSON.stringify(confirmed, null, 1))
}

await browser.close()
log(`${flagged.length - confirmed.length} recovered, ${confirmed.length} genuinely do not preview`)
