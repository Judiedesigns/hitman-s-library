// lib/design-queries.ts
// Single source of truth for reading the library.
//
// Both the server-rendered gallery and /api/design/filter-advanced call these,
// so the first paint and every subsequent fetch cannot drift apart.
import { unstable_cache } from 'next/cache'
import { toHttps } from '@/lib/secure-url'
import { neon } from '@neondatabase/serverless'
import { cleanTitle, decodeEntities } from './clean-title'
import { compareCategories, denormalizeIndustry, normalizeIndustry } from './categories'

const sql = neon(process.env.DATABASE_URL!)

export type SortBy = 'recent' | 'oldest' | 'name' | 'quality'

/**
 * What kind of site it is — the axis the library is actually browsed on.
 *
 * It replaced `industry`, which asked what business the site's customer is in.
 * That answered a question nobody browsing a design library was asking, and it
 * answered it badly: 104 of 279 sites were filed as "SaaS" and another 105 as
 * some flavour of uncategorised, so three quarters of the shelf sat in two
 * buckets that told you nothing. A studio like hex.inc was filed as E-commerce.
 *
 * `Unsorted` is not a kind. It is where a newly added site waits until someone
 * files it, and it sorts last.
 */
export const KINDS = [
  'Product', 'Studio', 'Editorial', 'Company', 'Portfolio', 'Store', 'Venue', 'Event',
] as const
export type Kind = (typeof KINDS)[number]
export const UNSORTED = 'Unsorted'

export interface DesignRecord {
  id: string
  url: string
  title: string
  kind: string
  thumbnail_url?: string
  fallback_thumbnail?: string | null
  colors: string[]
  typography: string[]
  layout: string
  quality: number
  tags: string[]
  architecture: string
  addedDate: string
  designStyle?: string
  complexity?: string
  useCase?: string
}

export interface QueryOptions {
  kinds?: string[]
  tags?: string[]
  search?: string
  sortBy?: SortBy
  limit?: number
  offset?: number
}

export interface QueryResult {
  designs: DesignRecord[]
  pagination: { total: number; limit: number; offset: number; hasMore: boolean }
}

const SORT_CLAUSES: Record<SortBy, string> = {
  recent: 'ds.created_at DESC',
  oldest: 'ds.created_at ASC',
  name: 'ds.source_name ASC',
  quality: "(ds.metadata->>'quality')::int DESC NULLS LAST, ds.created_at DESC",
}

function parseTags(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return raw.split(',').map(t => t.trim()).filter(Boolean)
    }
  }
  return []
}

/**
 * Some thumbnail URLs were scraped out of HTML attributes and stored with their
 * entities intact ("?auto=format&amp;fit=crop"), which makes them 404. Decode on
 * read so existing rows work without a migration.
 */
function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  return toHttps(decodeEntities(raw))
}

function parseMetadata(raw: unknown): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  if (typeof raw === 'object') return raw as Record<string, any>
  return {}
}

export async function queryDesigns(opts: QueryOptions = {}): Promise<QueryResult> {
  const {
    kinds = [],
    tags = [],
    search = '',
    sortBy = 'recent',
    limit = 32,
    offset = 0,
  } = opts

  const sortClause = SORT_CLAUSES[sortBy] ?? SORT_CLAUSES.recent

  // Only surface sites that have a screenshot — those are ready to preview.
  const whereConditions: string[] = ['ds.screenshot_url IS NOT NULL']
  const filterParams: any[] = []

  if (kinds.length > 0 && !kinds.includes('all')) {
    const placeholders = kinds.map((_, i) => `$${filterParams.length + i + 1}`).join(',')
    // A site with no kind yet answers to Unsorted, so nothing is unreachable.
    whereConditions.push(`COALESCE(ds.kind, '${UNSORTED}') IN (${placeholders})`)
    filterParams.push(...kinds)
  }

  if (tags.length > 0) {
    // tags is TEXT[]; && is "arrays overlap", i.e. matches any selected tag.
    whereConditions.push(`ds.tags && $${filterParams.length + 1}::text[]`)
    filterParams.push(tags)
  }

  if (search) {
    const idx = filterParams.length + 1
    whereConditions.push(`(ds.source_name ILIKE $${idx} OR ds.source_url ILIKE $${idx})`)
    filterParams.push(`%${search}%`)
  }

  const whereClause = `WHERE ${whereConditions.join(' AND ')}`

  const mainQuery = `
    SELECT
      ds.id,
      ds.source_url,
      ds.source_name,
      ds.kind,
      ds.metadata,
      ds.tags,
      ds.created_at,
      ds.thumbnail_url,
      ds.screenshot_url,
      (SELECT ARRAY(
        SELECT hex_value FROM design_colors
        WHERE source_id = ds.id AND hex_value IS NOT NULL
        ORDER BY id LIMIT 8
      )) AS hex_colors,
      (SELECT ARRAY(
        SELECT DISTINCT font_family FROM design_typography
        WHERE source_id = ds.id AND role != 'legacy' AND font_family IS NOT NULL
        LIMIT 3
      )) AS font_families
    FROM design_sources ds
    ${whereClause}
    ORDER BY ${sortClause}
    LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}
  `

  const countQuery = `SELECT COUNT(*) as total FROM design_sources ds ${whereClause}`

  const [results, countResult] = await Promise.all([
    sql.query(mainQuery, [...filterParams, limit, offset]),
    sql.query(countQuery, filterParams),
  ])

  const total = parseInt(countResult[0]?.total ?? '0', 10)

  const designs: DesignRecord[] = results.map((row: any) => {
    const metadata = parseMetadata(row.metadata)
    return {
      id: String(row.id),
      url: row.source_url,
      title: cleanTitle(row.source_name, row.source_url),
      kind: row.kind || UNSORTED,
      thumbnail_url: cleanUrl(row.screenshot_url) || cleanUrl(row.thumbnail_url) || undefined,
      fallback_thumbnail: row.screenshot_url ? cleanUrl(row.thumbnail_url) : null,
      colors: Array.isArray(row.hex_colors) ? row.hex_colors.filter(Boolean) : [],
      typography: Array.isArray(row.font_families) ? row.font_families.filter(Boolean) : [],
      layout: metadata.layout || 'Standard',
      designStyle: metadata.designStyle || 'Modern',
      architecture: metadata.architecture || 'Custom',
      quality: metadata.quality || 5,
      complexity: metadata.complexity,
      useCase: metadata.useCase,
      tags: parseTags(row.tags),
      addedDate: new Date(row.created_at).toISOString(),
    }
  })

  return {
    designs,
    pagination: { total, limit, offset, hasMore: offset + limit < total },
  }
}

export async function queryCategories(): Promise<{ name: string; count: number }[]> {
  const rows = await sql`
    SELECT COALESCE(kind, ${UNSORTED}) AS kind, COUNT(*) as count
    FROM design_sources
    WHERE screenshot_url IS NOT NULL
    GROUP BY 1
  `

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.kind] = Number(row.count)

  // Fixed order rather than by size. The rail is a list of what the library
  // holds, and a list that reshuffles as sites are added is one you have to
  // read again every visit.
  const ordered = KINDS
    .filter(name => counts[name])
    .map(name => ({ name: name as string, count: counts[name] }))

  if (counts[UNSORTED]) ordered.push({ name: UNSORTED, count: counts[UNSORTED] })
  return ordered
}

/**
 * The crawlable index of the whole collection.
 *
 * The gallery paginates as you scroll, so this list is what guarantees every
 * site is reachable from the HTML. It is also completely identical between
 * requests, and it was being recomputed — 100 full rows, joins and all — on
 * every single page view, purely to render links nobody sees. Cache it.
 */
export const queryAllSitesIndex = unstable_cache(
  async () => {
    const rows = await sql`
      SELECT id, source_url, source_name
      FROM design_sources
      WHERE screenshot_url IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200
    `
    return rows.map(row => ({
      id: String(row.id),
      url: row.source_url as string,
      title: cleanTitle(row.source_name, row.source_url),
    }))
  },
  ['all-sites-index'],
  { revalidate: 3600, tags: ['designs'] },
)

/**
 * Category counts change only when a site is added or removed, so serving them
 * a few minutes stale costs nothing and takes a query off the render path.
 */
export const queryCategoriesCached = unstable_cache(
  queryCategories,
  ['categories'],
  { revalidate: 300, tags: ['designs'] },
)
