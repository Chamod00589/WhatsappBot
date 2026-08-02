import type { MetadataRoute } from 'next'

/**
 * Web App Manifest — Chrome/Android "Install app" uses this instead of
 * bookmarking the current URL (which was landing on /dashboard).
 *
 * start_url `/` hits `app/page.tsx`, which redirects to `/inbox`.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'wacrm',
    short_name: 'wacrm',
    description: 'WhatsApp CRM inbox',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#020617',
    theme_color: '#020617',
    lang: 'en',
    icons: [
      {
        src: '/icon-192',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
