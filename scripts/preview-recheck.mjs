// Re-tests only the sites that failed the parallel audit, one at a time, in a
// fresh browser, with a longer settle.
//
// The parallel run is worth distrusting: four headless renderers loading heavy
// third-party pages at once produce Chrome's own "this page couldn't load" for
// reasons that have nothing to do with the site. A failure only counts if it
// survives being tested alone.
import puppeteer from 'puppeteer'
import sharp from 'sharp'
import fs from 'fs'

const BASE = process.env.BASE_URL || 'https://hitmanslibrary.xyz'
const results = JSON.parse(fs.readFileSync('preview-results.json', 'utf8'))
const suspects = results.filter(r => !r.ok)
const FAILURE_TEXT = [
  "this page couldn't load", 'this page couldn’t load',
  'application error: a client-side exception', 'just a moment',
  'attention required', 'access denied', 'error 1015', 'are you a robot',
  'verify you are human', 'enable javascript to run this app',
  '403 forbidden', '404 not found', 'this site can’t be reached',
]
const log = m => { console.log(m); fs.appendFileSync('preview-recheck.log', m + '\n') }
log(`re-testing ${suspects.length} suspects one at a time`)
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })

const confirmed = []
for (const s of suspects) {
  let verdict = null
  for (let attempt = 1; attempt <= 2 && !verdict?.ok; attempt++) {
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 1280, height: 800 })
      await page.goto(`${BASE}/api/proxy?url=${encodeURIComponent(s.url)}&picker=0`,
        { waitUntil: 'domcontentloaded', timeout: 45000 })
      await new Promise(r => setTimeout(r, 12000))
      const seen = await page.evaluate(() => ({
        text: (document.body?.innerText || '').trim(),
        imgs: [...document.images].filter(i => i.naturalWidth > 0).length,
        canvas: document.querySelectorAll('canvas, svg, video').length,
      }))
      const st = await sharp(await page.screenshot({ type: 'png' })).stats()
      const spread = st.channels.reduce((a, c) => a + c.stdev, 0) / st.channels.length
      const lower = seen.text.toLowerCase()
      const hit = FAILURE_TEXT.find(f => lower.includes(f))
      const substance = seen.text.length >= 100 || seen.imgs >= 2 || seen.canvas >= 1
      verdict = {
        ok: spread >= 4 && !hit && substance,
        why: spread < 4 ? `nothing painted (spread ${spread.toFixed(1)})`
           : hit ? `error page: "${hit}"`
           : !substance ? `painted, but empty (${seen.text.length} chars)` : null,
      }
    } catch (e) {
      verdict = { ok: false, why: String(e).slice(0, 80) }
    } finally {
      await page.close().catch(() => {})
    }
    if (!verdict.ok && attempt === 1) await new Promise(r => setTimeout(r, 3000))
  }
  if (verdict.ok) log(`recovered ${s.id} ${s.url}`)
  else { confirmed.push({ ...s, why: verdict.why }); log(`CONFIRMED ${s.id} ${s.url} — ${verdict.why}`) }
}

await browser.close()
fs.writeFileSync('preview-confirmed.json', JSON.stringify(confirmed, null, 1))
log(`\n${suspects.length - confirmed.length} recovered, ${confirmed.length} genuinely do not preview`)
