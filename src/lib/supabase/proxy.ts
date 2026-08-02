import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Edge fetch sometimes fails transiently on the first hop (DNS/TLS).
 * One retry avoids the multi-second auth-js backoff loop that surfaces as
 * `Error: fetch failed` from Next's edge sandbox during token refresh.
 */
async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (first) {
    try {
      return await fetch(input, init)
    } catch {
      throw first
    }
  }
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: fetchWithRetry },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
          Object.entries(headers).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value),
          )
        },
      },
    },
  )

  // createServerClient registers onAuthStateChange, which schedules a
  // background _emitInitialSession. Kick initialize() in the same tick so
  // that microtask awaits the same promise instead of racing getClaims()
  // on a single-use refresh token (issue #288 / supabase/ssr#68).
  await supabase.auth.initialize()

  // Prefer getClaims(): verifies the JWT locally (JWKS) when possible and
  // only hits the network to refresh near expiry — unlike getUser().
  let user: { sub?: string } | null = null
  try {
    const { data } = await supabase.auth.getClaims()
    user = data?.claims ?? null
  } catch {
    // Network blip during refresh — treat as signed-out for this request
    // rather than hanging the proxy for 10s+ of auth-js retries.
    user = null
  }

  // getClaims()/initialize() may rotate cookies onto supabaseResponse.
  // Redirect/JSON branches must copy those Set-Cookie headers or the
  // browser keeps the consumed refresh token and the session wedges.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  if (
    user &&
    (request.nextUrl.pathname === '/login' ||
      request.nextUrl.pathname === '/signup' ||
      request.nextUrl.pathname === '/forgot-password')
  ) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/inbox'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  const protectedPaths = [
    '/dashboard',
    '/inbox',
    '/contacts',
    '/pipelines',
    '/broadcasts',
    '/automations',
    '/settings',
  ]
  if (
    !user &&
    protectedPaths.some((path) => request.nextUrl.pathname.startsWith(path))
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )
  }

  return supabaseResponse
}
