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
/** Longer than the panel's 8s give-up timer, so a verdict is settled. */
const SETTLE_MS = 15000
const LANES = 2

const log = m => { console.log(m); fs.appendFileSync('panel-sweep.log', m + '\n') }

async function judge(browser, id, bp) {
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: bp.width, height: bp.height, isMobile: bp.mobile, hasTouch: bp.mobile })
    if (bp.mobile) await page.setUserAgent(PHONE_UA)
    await page.goto(`${BASE}/?site=${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await new Promise(r => setTimeout(r, SETTLE_MS))
    const live = await page.evaluate(() => document.querySelectorAll('iframe').length > 0)
    return { ok: live, why: live ? null : 'panel fell back to a capture' }
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 80) }
  } finally {
    await page.close().catch(() => {})
  }
}

const sites = await sql`
  SELECT id, source_url as url, source_name as name, kind
  FROM design_sources ORDER BY id`
log(`checking the panel for ${sites.length} sites at both breakpoints`)

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

const flagged = []
let cursor = 0, done = 0
await Promise.all(Array.from({ length: LANES }, async () => {
  while (cursor < sites.length) {
    const s = sites[cursor++]
    const bad = []
    for (const bp of BREAKPOINTS) {
      const v = await judge(browser, s.id, bp)
      if (!v.ok) bad.push(`${bp.name}: ${v.why}`)
    }
    if (bad.length) flagged.push({ ...s, bad })
    if (++done % 20 === 0) log(`  ${done}/${sites.length} checked, ${flagged.length} flagged`)
  }
}))
log(`phase one: ${flagged.length} flagged`)

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
