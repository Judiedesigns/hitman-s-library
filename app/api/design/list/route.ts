import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { toHttps } from '@/lib/secure-url'
import { denormalizeIndustry, normalizeIndustry } from '@/lib/categories'

const sql = neon(process.env.DATABASE_URL!)

const SELECT_FIELDS = `
  SELECT id, source_url, source_name, industry, metadata, tags, created_at, screenshot_url, mobile_screenshot_url, figma_capture_url, thumbnail_url
  FROM design_sources
`

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const industry = searchParams.get('industry')
    const search = searchParams.get('search')
    const rawIndustries = industry && industry !== 'all' ? denormalizeIndustry(industry) : []

    let results: any[]

    if (rawIndustries.length > 0 && search) {
      const placeholders = rawIndustries.map((_, index) => `$${index + 1}`).join(',')
      results = await sql.query(`
        ${SELECT_FIELDS}
        WHERE LOWER(industry) IN (${placeholders})
          AND (source_name ILIKE $${rawIndustries.length + 1} OR tags::text ILIKE $${rawIndustries.length + 1})
        ORDER BY created_at DESC
      `, [...rawIndustries, `%${search}%`])
    } else if (rawIndustries.length > 0) {
      const placeholders = rawIndustries.map((_, index) => `$${index + 1}`).join(',')
      results = await sql.query(`
        ${SELECT_FIELDS}
        WHERE LOWER(industry) IN (${placeholders})
        ORDER BY created_at DESC
      `, rawIndustries)
    } else if (search) {
      results = await sql`
        SELECT id, source_url, source_name, industry, metadata, tags, created_at, screenshot_url, mobile_screenshot_url, figma_capture_url, thumbnail_url
        FROM design_sources
        WHERE source_name ILIKE ${`%${search}%`}
           OR industry ILIKE ${`%${search}%`}
           OR tags::text ILIKE ${`%${search}%`}
        ORDER BY created_at DESC
      `
    } else {
      results = await sql`
        SELECT id, source_url, source_name, industry, metadata, tags, created_at, screenshot_url, mobile_screenshot_url, figma_capture_url, thumbnail_url
        FROM design_sources
        ORDER BY created_at DESC
      `
    }

    const designs = results.map((row: any) => {
      let metadata: any = {}
      if (row.metadata) {
        if (typeof row.metadata === 'string') {
          try { metadata = JSON.parse(row.metadata) } catch { /* ignore */ }
        } else if (typeof row.metadata === 'object') {
          metadata = row.metadata
        }
      }

      return {
        id: row.id,
        url: row.source_url,
        title: row.source_name,
        industry: normalizeIndustry(row.industry),
        created_at: row.created_at,
        screenshot_url: toHttps(row.screenshot_url),
        mobile_screenshot_url: toHttps(row.mobile_screenshot_url),
        figma_capture_url: row.figma_capture_url ?? null,
        thumbnail_url: toHttps(row.thumbnail_url),
        extraction_error: metadata.extraction_error ?? null,
      }
    })

    return NextResponse.json(designs)
  } catch (error) {
    console.error('List designs error:', error)
    return NextResponse.json({ error: 'Failed to fetch designs', designs: [] }, { status: 200 })
  }
}
