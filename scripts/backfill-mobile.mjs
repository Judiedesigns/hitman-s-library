// One-off backfill: capture the mobile breakpoint for every site missing one.
//
// Runs locally rather than through /api/admin/mobile-capture because that route
// is bound by the 60s serverless ceiling and captures one site per request.
//
// It differs from the route in one deliberate way: the mobile viewport and UA
// are set BEFORE navigation, not after. A site that serves a different document
// to phones was previously navigated at 1440px and only then squeezed to 390px,
// which captures a desktop page at phone width — the squished-desktop picture,
// not the mobile layout.
import { neon } from '@neondatabase/serverless'
import { put } from '@vercel/blob'
import puppeteer from 'puppeteer'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const pick = k => env.match(new RegExp('^' + k + '=(.*)$', 'm'))[1].replace(/^["']|["']$/g, '')
process.env.BLOB_READ_WRITE_TOKEN = pick('BLOB_READ_WRITE_TOKEN')
const sql = neon(pick('DATABASE_URL'))

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const MAX_DEVICE_PIXELS = 15000
const CONCURRENCY = 4

const log = m => { const s = `[${new Date().toISOString().slice(11,19)}] ${m}`; console.log(s); fs.appendFileSync('backfill-mobile.log', s + '\n') }

async function autoScroll(page, step = 300) {
  await page.evaluate(async step => {
    await new Promise(resolve => {
      let y = 0
      const id = setInterval(() => {
        const maxY = document.documentElement.scrollHeight
        y = Math.min(y + step, maxY)
        window.scrollTo(0, y)
        if (y >= maxY) { clearInterval(id); window.scrollTo(0, 0); resolve() }
      }, 80)
    })
  }, step).catch(() => {})
}

async function captureClamped(page, quality) {
  const { scrollWidth, scrollHeight, viewportWidth, dpr } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    viewportWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
  }))
  const budget = Math.floor(MAX_DEVICE_PIXELS / Math.max(dpr, 1))
  const width = scrollWidth > viewportWidth * 1.5 ? viewportWidth : Math.min(scrollWidth, budget)
  const height = Math.min(scrollHeight, budget)
  if (scrollWidth <= budget && scrollHeight <= budget && width === scrollWidth) {
    return await page.screenshot({ fullPage: true, type: 'webp', quality })
  }
  return await page.screenshot({
    type: 'webp', quality, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  })
}

async function capture(browser, row) {
  const page = await browser.newPage()
  try {
    await page.setBypassCSP(true)
    await page.setUserAgent(MOBILE_UA)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
    try {
      await page.goto(row.source_url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    } catch (navErr) {
      if (page.url() === 'about:blank') throw navErr
    }
    await new Promise(r => setTimeout(r, 2000))
    await autoScroll(page, 300)
    await new Promise(r => setTimeout(r, 800))

    const buffer = await captureClamped(page, 92)
    if (!buffer || buffer.length < 2000) throw new Error(`empty/tiny buffer (${buffer?.length ?? 0}b)`)

    const hostname = new URL(row.source_url).hostname.replace(/\./g, '-')
    const blob = await put(`screenshots/${hostname}-${Date.now()}-mobile.webp`, buffer, {
      access: 'public', contentType: 'image/webp',
    })
    await sql.query('UPDATE design_sources SET mobile_screenshot_url = $1 WHERE id = $2', [blob.url, row.id])
    return { ok: true, bytes: buffer.length }
  } finally {
    await page.close().catch(() => {})
  }
}

const only = process.argv[2] === '--ids' ? process.argv[3].split(',').map(Number) : null
const rows = only
  ? await sql.query('SELECT id, source_name, source_url FROM design_sources WHERE id = ANY($1) ORDER BY id', [only])
  : await sql.query('SELECT id, source_name, source_url FROM design_sources WHERE mobile_screenshot_url IS NULL ORDER BY id')

log(`backfilling ${rows.length} sites`)
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const failures = []
let done = 0

async function worker(queue) {
  while (queue.length) {
    const row = queue.shift()
    let lastErr
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await capture(browser, row)
        log(`ok   ${row.id} ${(r.bytes/1024).toFixed(0)}kb ${row.source_url}`)
        lastErr = null
        break
      } catch (e) { lastErr = e; if (attempt === 1) await new Promise(r => setTimeout(r, 1500)) }
    }
    if (lastErr) { failures.push({ id: row.id, url: row.source_url, err: String(lastErr).slice(0, 140) }); log(`FAIL ${row.id} ${row.source_url} — ${String(lastErr).slice(0,100)}`) }
    done++
    if (done % 10 === 0) log(`--- ${done}/${rows.length} ---`)
  }
}

const queue = [...rows]
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
await browser.close()
fs.writeFileSync('backfill-failures.json', JSON.stringify(failures, null, 1))
log(`done. ${rows.length - failures.length} captured, ${failures.length} failed`)
