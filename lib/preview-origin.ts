/**
 * Where the live preview's HTML is served from.
 *
 * The preview iframe needs `allow-same-origin`, because a sandbox without it
 * gives the framed page an opaque origin: `localStorage` throws on access, and
 * a modern site's hydration dies on the first read. Measured across the
 * library, that was nearly every site — the panel loaded an iframe, the page
 * crashed inside it, and the capture took over within three seconds.
 *
 * But `allow-same-origin` grants the framed page whatever origin the document
 * came from, and third-party JavaScript holding *our* origin could read the
 * app's storage, reach `window.parent`, and call `/api/admin/*` with the
 * session cookie attached. So the proxy is served from its own host instead,
 * and "same origin" resolves to that host rather than to the app.
 *
 * The admin session cookie is host-only — no Domain attribute — so it is never
 * sent to the preview host. Storage is per-origin, so nothing is shared.
 *
 * Returns '' when there is no separate host to use, and the caller then leaves
 * `allow-same-origin` off rather than granting it on our own origin. Previews
 * are worse in that case, which is the correct way round.
 */
export function previewOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_PREVIEW_ORIGIN
  if (configured) return configured.replace(/\/+$/, '')
  if (typeof window === 'undefined') return ''

  const { hostname, protocol, port } = window.location

  // localhost and 127.0.0.1 are the same server and different origins, which
  // is exactly the separation this needs — so dev gets a real preview too.
  if (hostname === 'localhost') return `${protocol}//127.0.0.1${port ? `:${port}` : ''}`
  if (hostname === '127.0.0.1') return `${protocol}//localhost${port ? `:${port}` : ''}`

  const apex = hostname.replace(/^www\./, '')
  if (apex === 'hitmanslibrary.xyz') return `${protocol}//preview.${apex}`

  // A deployment URL with no preview host of its own. Same origin, strict
  // sandbox, degraded previews — never our origin with the guard rail off.
  return ''
}
