// Does the preview panel show a live site, for every site, at both breakpoints?
//
// preview-sweep.mjs loads /api/proxy at the top level, which measures whether
// the proxy can render a site at all. This measures the thing the visitor
// actually gets: the panel, its sandboxed iframe, and the fallback logic that
// decides between a live page and a still. Those differ — a sandbox without
// allow-same-origin makes localStorage throw, and that alone used to take the
// live preview down on almost every site while the top-level proxy was fine.
//
// A site counts as previewing when an iframe is still on screen after the
// panel's own budget has elapsed. If the panel swapped in a capture, the live
// preview lost.
import { neon } from '@neondatabase/serverless'
import puppeteer from 'puppeteer'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const sql = neon(env.match(/^DATABASE_URL=(.*)$/m)[1].replace(/^["']|["']$/g, ''))
const BASE = process.env.BASE_URL || 'https://hitmanslibrary.xyz'
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const BREAKPOINTS = [
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
]
/**
 * Hard cap. Past the panel's own 20s give-up timer, a verdict has settled one
 * way or the other.
 */
const CAP_MS = 23000
/** A visible frame that survives this long has not been swapped for a still. */
const STABLE_MS = 4000
const POLL_MS = 500
/**
 * One at a time. Two lanes starve each other badly enough to change the
 * answer: heavy sites miss the panel's give-up timer and fall back, and a run
 * at two lanes flagged Reducto, Terra and six others that preview perfectly
 * when checked alone. Polling for an early verdict buys back most of the time
 * that costs, since the common case settles in well under the cap.
 */
const LANES = 1

const log = m => { console.log(m); fs.appendFileSync('panel-sweep.log', m + '\n') }

async function judge(browser, id, bp) {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: bp.width, height: bp.height, isMobile: bp.mobile, hasTouch: bp.mobile })
    if (bp.mobile) await page.setUserAgent(PHONE_UA)
    await page.goto(`${BASE}/?site=${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })

    const started = Date.now()
    let visibleSince = null
    while (Date.now() - started < CAP_MS) {
      await new Promise(r => setTimeout(r, POLL_MS))
      /**
       * The visible frame, not any frame. The panel mounts its desktop and its
       * phone layout together and hides one with CSS, so a bare count answers
       * a question nobody asked — a run where the hidden copy failed and the
       * visible one was fine counted as a failure.
       */
      const state = await page.evaluate(() => {
        const big = el => { const r = el.getBoundingClientRect(); return r.width > 50 && r.height > 50 }
        return {
          live: [...document.querySelectorAll('iframe')].some(big),
          still: [...document.querySelectorAll('img')]
            .filter(i => /screenshot/i.test(i.alt || '')).some(big),
        }
      }).catch(() => null)
      if (!state) continue

      // A visible capture is the panel saying it gave up. That is final.
      if (state.still) return { ok: false, why: 'panel fell back to a capture' }
      if (state.live) {
        if (visibleSince === null) visibleSince = Date.now()
        if (Date.now() - visibleSince >= STABLE_MS) return { ok: true, why: null }
      } else {
        visibleSince = null
      }
    }
    return { ok: false, why: 'no live frame within the panel\'s own budget' }
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 80) }
  } finally {
    await page.close().catch(() => {})
  }
}

const all = await sql`
  SELECT id, source_url as url, source_name as name, kind
  FROM design_sources ORDER BY id`

// Resume support. A run of this length gets interrupted, and re-testing a site
// that has already been settled costs half a minute for an answer we have.
const STATE = 'panel-done.json'
const prior = fs.existsSync(STATE)
  ? JSON.parse(fs.readFileSync(STATE, 'utf8'))
  : { done: [], flagged: [] }
const settled = new Set(prior.done)
const sites = all.filter(s => !settled.has(s.id))
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || null
const queue = limit ? sites.slice(0, limit) : sites
log(`checking the panel for ${queue.length} sites at both breakpoints (${settled.size} already settled)`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

const flagged = [...prior.flagged]
let cursor = 0, done = 0
await Promise.all(Array.from({ length: LANES }, async () => {
  while (cursor < queue.length) {
    const s = queue[cursor++]
    const bad = []
    for (const bp of BREAKPOINTS) {
      const v = await judge(browser, s.id, bp)
      if (!v.ok) bad.push(`${bp.name}: ${v.why}`)
    }
    if (bad.length) flagged.push({ ...s, bad })
    settled.add(s.id)
    fs.writeFileSync(STATE, JSON.stringify({ done: [...settled], flagged }, null, 1))
    if (++done % 20 === 0) log(`  ${done}/${queue.length} checked, ${flagged.length} flagged so far`)
  }
}))
log(`phase one: ${flagged.length} flagged of ${settled.size} settled`)

if (queue.length && settled.size < all.length) {
  log(`stopping after this chunk — ${all.length - settled.size} still unchecked, re-run to continue`)
  await browser.close()
  process.exit(0)
}

// Alone, twice, before it counts — same discipline as every other sweep here.
const confirmed = []
for (const [i, s] of flagged.entries()) {
  const bad = []
  for (const bp of BREAKPOINTS) {
    let v = null
    for (let attempt = 1; attempt <= 2 && !v?.ok; attempt++) v = await judge(browser, s.id, bp)
    if (!v.ok) bad.push(`${bp.name}: ${v.why}`)
  }
  if (bad.length) {
    confirmed.push({ id: s.id, url: s.url, name: s.name, why: bad.join('; ') })
    log(`  [${i + 1}/${flagged.length}] ${s.id} ${s.name?.slice(0, 40)} FAILS — ${bad.join('; ')}`)
  } else {
    log(`  [${i + 1}/${flagged.length}] ${s.id} recovered alone`)
  }
  fs.writeFileSync('panel-confirmed.json', JSON.stringify(confirmed, null, 1))
}

await browser.close()
log(`${flagged.length - confirmed.length} recovered, ${confirmed.length} do not preview live in the panel`)
