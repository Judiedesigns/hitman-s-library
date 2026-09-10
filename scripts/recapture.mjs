// Re-capture sites whose stored capture does not show the page.
//
// Two problems this exists for, both found by scripts/validate-captures.mjs:
//   • eight rows never held a screenshot at all — one pointed at a
//     screenshot.rocks service page that returns HTML, another at the site's own
//     OG image — so the gallery was showing a borrowed picture, not a capture;
//   • twelve mobile blobs were uploaded empty or came back a single flat colour.
//
// Usage: node scripts/recapture.mjs --desktop 13,31 --mobile 34,97
import { neon } from '@neondatabase/serverless'
import { put } from '@vercel/blob'
import puppeteer from 'puppeteer'
import fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const pick = k => env.match(new RegExp('^' + k + '=(.*)$', 'm'))[1].replace(/^["']|["']$/g, '')
process.env.BLOB_READ_WRITE_TOKEN = pick('BLOB_READ_WRITE_TOKEN')
const sql = neon(pick('DATABASE_URL'))

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const MAX_DEVICE_PIXELS = 15000

const arg = name => {
  const i = process.argv.indexOf(name)
  return i === -1 ? [] : (process.argv[i + 1] || '').split(',').filter(Boolean).map(Number)
}
const want = { desktop: arg('--desktop'), mobile: arg('--mobile') }

async function autoScroll(page, step) {
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
  return await page.screenshot({ type: 'webp', quality, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 } })
}

async function shoot(browser, row, which) {
  const page = await browser.newPage()
  try {
    await page.setBypassCSP(true)
    if (which === 'mobile') {
      await page.setUserAgent(MOBILE_UA)
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
    } else {
      await page.setUserAgent(DESKTOP_UA)
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
    }
    try {
      await page.goto(row.source_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) { if (page.url() === 'about:blank') throw e }
    await new Promise(r => setTimeout(r, 2500))
    await autoScroll(page, which === 'mobile' ? 300 : 400)
    await new Promise(r => setTimeout(r, 1000))

    const buffer = await captureClamped(page, which === 'mobile' ? 92 : 88)
    if (!buffer || buffer.length < 5000) throw new Error(`tiny buffer (${buffer?.length ?? 0}b)`)

    const host = new URL(row.source_url).hostname.replace(/\./g, '-')
    const suffix = which === 'mobile' ? '-mobile' : ''
    const blob = await put(`screenshots/${host}-${Date.now()}${suffix}.webp`, buffer, {
      access: 'public', contentType: 'image/webp',
    })
    const col = which === 'mobile' ? 'mobile_screenshot_url' : 'screenshot_url'
    await sql.query(`UPDATE design_sources SET ${col} = $1 WHERE id = $2`, [blob.url, row.id])
    return buffer.length
  } finally { await page.close().catch(() => {}) }
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const failed = []
for (const which of ['desktop', 'mobile']) {
  for (const id of want[which]) {
    const [row] = await sql.query('SELECT id, source_url FROM design_sources WHERE id = $1', [id])
    if (!row) { console.log(`skip ${id} — no such row`); continue }
    try {
      const bytes = await shoot(browser, row, which)
      console.log(`ok   ${id} ${which} ${(bytes / 1024).toFixed(0)}kb ${row.source_url}`)
    } catch (e) {
      failed.push({ id, which, url: row.source_url, err: String(e).slice(0, 100) })
      console.log(`FAIL ${id} ${which} ${row.source_url} — ${String(e).slice(0, 80)}`)
    }
  }
}
await browser.close()
console.log(failed.length ? `\n${failed.length} still failing` : '\nall re-captured')
