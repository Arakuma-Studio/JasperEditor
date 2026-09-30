// Service-worker request classification (ARCHITECTURE §12, S05:PWA-004, R-OMS §8.3). public/sw.js carries
// a byte-for-byte equivalent copy of `classifyRequest` (a test runs both over the same table), because the
// service worker is a plain classic script served as-is.
//
//   bypass   → never respondWith: engine routes, media/proxy/thumbnail/waveform/render URLs, blob:, data:,
//              cross-origin, non-GET and ANY request with a Range header (Cache Storage cannot hold 206s,
//              and multi-GB media must never touch it)
//   navigate → network-first, cached under /index.html, offline fallback to the cached shell
//   asset    → cache-first (content-hashed /assets/*, engine-served /fonts/*)
//   static   → network-first with cache fallback (manifest, icons, theme-boot.js…)

export const SW_VERSION = 'v1';
export const SHELL_CACHE = `jasper-shell-${SW_VERSION}`;
export const ASSETS_CACHE = `jasper-assets-${SW_VERSION}`;

/** Path prefixes the service worker never handles (engine and media routes). */
export const BYPASS_PREFIXES = [
	'/api',
	'/events',
	'/agent',
	'/ws',
	'/health',
	'/media',
	'/mg',
	'/renders',
] as const;
/** Cache-first prefixes (immutable content). */
export const CACHE_FIRST_PREFIXES = ['/assets/', '/fonts/'] as const;
/** App-shell files precached on install. */
export const PRECACHE_URLS = [
	'/',
	'/index.html',
	'/theme-boot.js',
	'/manifest.webmanifest',
	'/icons/icon-192.png',
	'/icons/icon-512.png',
] as const;

export type SwRoute = 'bypass' | 'navigate' | 'asset' | 'static';

export type SwRequestInfo = {
	url: string;
	method: string;
	/** `Request.mode` ('navigate' for page loads). */
	mode?: string;
	/** The request carries a Range header. */
	hasRange?: boolean;
	/** The service worker's origin (`self.location.origin`). */
	origin: string;
};

export function classifyRequest(req: SwRequestInfo): SwRoute {
	if (req.method !== 'GET') return 'bypass';
	if (req.hasRange) return 'bypass';
	let u: URL;
	try {
		u = new URL(req.url);
	} catch {
		return 'bypass';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bypass';
	if (u.origin !== req.origin) return 'bypass';
	const path = u.pathname;
	for (const p of BYPASS_PREFIXES) if (path === p || path.startsWith(`${p}/`)) return 'bypass';
	if (req.mode === 'navigate') return 'navigate';
	for (const p of CACHE_FIRST_PREFIXES) if (path.startsWith(p)) return 'asset';
	return 'static';
}
