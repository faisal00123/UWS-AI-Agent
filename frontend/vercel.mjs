/**
 * Vercel project configuration (programmatic — executes at build time).
 *
 * Topology (see backend/docs/deployment.md):
 *
 *   Vercel  = this static SPA (no build step, hash router)
 *   Railway = the backend (Express + duplex WebSocket + SQLite + jobs)
 *
 * The SPA calls the API with RELATIVE paths (`/api/...`, same-origin), so
 * every /api request is rewritten to the Railway backend. That keeps
 * cookies, CSRF and session behaviour identical to a single-origin deploy.
 *
 * Required environment variable (set in the Vercel project settings —
 * NOT in this file):
 *
 *   RAILWAY_BACKEND_URL   e.g. https://uws-ai-agent.up.railway.app
 *
 * The build FAILS with an explicit message until it exists: a deploy without
 * an API origin would ship a dashboard that silently cannot reach its backend,
 * which is worse than a failed build. Deploy Railway first, copy its URL into
 * the Vercel environment variable, then deploy this project.
 *
 * WebSocket (/api/media) does NOT go through Vercel: Twilio connects straight
 * to the backend origin (PUBLIC_BASE_URL points at Railway), so no WS
 * proxying is required here.
 */

const backend = (process.env.RAILWAY_BACKEND_URL ?? '').trim().replace(/\/+$/, '');

if (!backend) {
  throw new Error(
    'RAILWAY_BACKEND_URL is not set. Deploy the backend to Railway first, then add its ' +
      'origin (e.g. https://your-service.up.railway.app) as the RAILWAY_BACKEND_URL ' +
      'environment variable in the Vercel project settings and redeploy. ' +
      'See backend/docs/deployment.md.',
  );
}

let backendOrigin;
try {
  const parsed = new URL(backend);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
  backendOrigin = parsed.origin;
} catch {
  throw new Error(`RAILWAY_BACKEND_URL must be an absolute http(s) URL, got: ${backend}`);
}

// Same policy the backend serves via helmet (backend/src/server/app.ts) so the
// SPA is equally locked down when Vercel serves it directly.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  'upgrade-insecure-requests',
].join('; ');

export const config = {
  framework: null,
  buildCommand: null,
  outputDirectory: '.',
  cleanUrls: false,
  trailingSlash: false,

  rewrites: [
    // The API (and webhooks, and probes) live on the backend.
    { source: '/api/:path*', destination: `${backendOrigin}/api/:path*` },
  ],

  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        { key: 'X-XSS-Protection', value: '0' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
      ],
    },
    {
      // Cache fingerprints only; index.html must revalidate so releases roll out.
      source: '/(app|lib|styles)\\.(js|css)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, must-revalidate' }],
    },
  ],
};
