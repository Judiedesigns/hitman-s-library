import { NextRequest, NextResponse } from 'next/server'
import { assertPublicUrl, safeFetch, BlockedUrlError } from '@/lib/safe-url'

export const runtime = 'nodejs'

/**
 * Subresource fetches for a proxied page.
 *
 * /api/proxy rewrites <base href> to the real origin so relative CSS, images
 * and links resolve. That also moves what a relative fetch() resolves to, and
 * those become cross-origin requests the site's own server sends no CORS
 * headers for — so they reject, and a page whose entrance animation waits on
 * one stays parked at opacity 0. The DOM fills with content and the screen
 * stays white.
 *
 * The injected shim routes those calls here instead, which makes them
 * same-origin again from the browser's point of view.
 *
 * This is deliberately not a general proxy: GET only, no credentials
 * forwarded, and safe-url rejects anything resolving to a private address,
 * revalidating on every redirect hop.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return new NextResponse('Missing url', { status: 400 })

  try {
    await assertPublicUrl(url)
  } catch (err) {
    return new NextResponse(err instanceof BlockedUrlError ? err.message : 'Invalid URL', { status: 400 })
  }

  try {
    const upstream = await safeFetch(url, {
      headers: {
        'User-Agent': req.headers.get('user-agent') ??
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: req.headers.get('accept') ?? '*/*',
      },
      signal: AbortSignal.timeout(10000),
    })

    const body = await upstream.arrayBuffer()
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
      },
    })
  } catch {
    // A failed subresource is routine on somebody else's page. Answer with a
    // status the caller can handle rather than a framework error page.
    return new NextResponse('', { status: 502 })
  }
}
