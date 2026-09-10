import { NextRequest, NextResponse } from 'next/server'
import { assertPublicUrl, safeFetch, BlockedUrlError } from '@/lib/safe-url'

export const runtime = 'nodejs'

const PREVIEW_SCRIPT = `<script>
(function () {
  'use strict';
  var reported = false;

  var style = document.createElement('style');
  style.textContent = [
    '*,*::before,*::after{cursor:auto!important}',
    'a[href],a[href] *,button,button *,[role="button"],[role="button"] *,summary,summary *,label,label *,select,input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"],[onclick],[onclick] *,[tabindex]:not([tabindex="-1"]),[tabindex]:not([tabindex="-1"]) *{cursor:pointer!important}',
    'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]),textarea{cursor:text!important}',
  ].join('');
  document.head.appendChild(style);

  function hideCustomCursorElements() {
    try {
      var els = document.querySelectorAll('[class*="cursor" i],[id*="cursor" i]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!(el instanceof HTMLElement)) continue;
        var cs = window.getComputedStyle(el);
        var rect = el.getBoundingClientRect();
        var looksOverlay = cs.position === 'fixed' || cs.position === 'absolute';
        var looksSmall = rect.width <= 180 && rect.height <= 180;
        var floatsAbovePage = cs.pointerEvents === 'none' || Number(cs.zIndex) > 100;
        if (looksOverlay && looksSmall && floatsAbovePage) {
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    } catch (err) {}
  }

  function report(reason) {
    if (reported) return;
    reported = true;
    window.parent.postMessage({ type: 'proxy-failed', reason: reason || 'client-side preview error' }, '*');
  }

  // Capture phase also catches subresource load failures (a 404 image, a
  // blocked font, an analytics beacon). Those are routine on a proxied
  // third-party page and say nothing about whether the page rendered, so
  // only a genuine uncaught script error counts as a failed preview.
  window.addEventListener('error', function (event) {
    if (!event || event.target !== window) return;
    if (!event.error && !event.message) return;
    report(event.message || 'client-side preview error');
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    report(event && event.reason ? String(event.reason) : 'unhandled preview rejection');
  }, true);

  function checkRenderedError() {
    try {
      var text = document.body ? document.body.innerText || '' : '';
      if (text.indexOf('Application error: a client-side exception has occurred') !== -1) {
        report('client-side exception');
      }
    } catch (err) {}
  }

  window.addEventListener('load', function () {
    hideCustomCursorElements();
    setTimeout(hideCustomCursorElements, 500);
    setTimeout(hideCustomCursorElements, 1500);
    setTimeout(checkRenderedError, 750);
    setTimeout(checkRenderedError, 2000);
  });

  if (document.readyState !== 'loading') hideCustomCursorElements();
  else document.addEventListener('DOMContentLoaded', hideCustomCursorElements, { once: true });
})();
</script>`

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url')
  if (!url) return new NextResponse('Missing url param', { status: 400 })

  // Reject non-public targets before any outbound request is made.
  let targetUrl: URL
  try {
    targetUrl = await assertPublicUrl(url)
  } catch (err) {
    const message = err instanceof BlockedUrlError ? err.message : 'Invalid URL'
    return new NextResponse(message, { status: 400 })
  }

  const proxyErrorPage = (reason: string) => new NextResponse(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
      window.parent.postMessage({ type: 'proxy-failed', reason: ${JSON.stringify(reason)} }, '*');
    </script></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  )

  let html: string
  try {
    // safeFetch re-validates each redirect hop — a public URL must not be able
    // to bounce us onto an internal one.
    const res = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok && res.status >= 400) return proxyErrorPage(`HTTP ${res.status}`)
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('html')) return proxyErrorPage('non-html response')
    html = await res.text()
  } catch (err) {
    return proxyErrorPage(String(err))
  }

  const origin = `${targetUrl.protocol}//${targetUrl.host}`
  // <base href> resolves all relative URLs (CSS, images, links) against the real origin
  const baseTag = `<base href="${origin}/">`

  // Strip CSP and X-Frame-Options meta tags — they block our injected scripts
  // (header-based CSP/XFO is already absent from our response, but some sites
  //  also set them via <meta http-equiv>, which the browser still enforces)
  html = html.replace(/<meta\b[^>]+\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
  html = html.replace(/<meta\b[^>]+\bhttp-equiv\s*=\s*["']?x-frame-options["']?[^>]*>/gi, '')

  const injected = html
    .replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    .replace(/<\/body>/i, `${PREVIEW_SCRIPT}</body>`)
    || html + PREVIEW_SCRIPT

  return new NextResponse(injected, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Every open of a panel used to re-fetch the whole third-party page from
      // origin, with a 10s budget to do it in, so the second look at a site
      // cost exactly as much as the first. The pages being proxied are public
      // marketing sites; a few minutes of staleness is invisible, and it turns
      // a repeat open into a cache hit.
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600',
      // Intentionally no X-Frame-Options or CSP — that's the point of this proxy
    },
  })
}
