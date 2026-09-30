// JasperEditor service worker (ARCHITECTURE §12, S05:PWA-004/005, R-OMS §3.5/§8.3). Hand-written and
// copied verbatim to dist/. `classifyRequest` mirrors apps/web/src/pwa/sw-routes.ts; the unit test
// apps/web/test/pwa.test.ts runs both over the same cases, so change them together and bump VERSION
// whenever the cached shell must be invalidated.

const VERSION = 'v1';
const SHELL_CACHE = `jasper-shell-${VERSION}`;
const ASSETS_CACHE = `jasper-assets-${VERSION}`;
const ASSETS_MAX_ENTRIES = 80;

const BYPASS_PREFIXES = ['/api', '/events', '/agent', '/ws', '/health', '/media', '/mg', '/renders'];
const CACHE_FIRST_PREFIXES = ['/assets/', '/fonts/'];
const PRECACHE_URLS = [
	'/',
	'/index.html',
	'/theme-boot.js',
	'/manifest.webmanifest',
	'/icons/icon-192.png',
	'/icons/icon-512.png',
];

/** 'bypass' | 'navigate' | 'asset' | 'static' — keep equal to sw-routes.ts classifyRequest. */
function classifyRequest(req) {
	if (req.method !== 'GET') return 'bypass';
	if (req.hasRange) return 'bypass';
	let u;
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

// Exposed for the equivalence test (harmless in browsers).
self.__jasperSw = {
	VERSION,
	SHELL_CACHE,
	ASSETS_CACHE,
	BYPASS_PREFIXES,
	CACHE_FIRST_PREFIXES,
	PRECACHE_URLS,
	classifyRequest,
};

self.addEventListener('install', (event) => {
	// Not cache.addAll: one missing file must not fail the whole install.
	event.waitUntil(
		caches.open(SHELL_CACHE).then((cache) =>
			Promise.all(
				PRECACHE_URLS.map((url) =>
					fetch(url, { cache: 'reload' })
						.then((res) => (res.ok ? cache.put(url === '/' ? '/index.html' : url, res) : undefined))
						.catch(() => undefined),
				),
			),
		),
	);
	// No skipWaiting here: the page shows "Update available · Reload" and posts SKIP_WAITING (S05:PWA-005).
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((k) => k.startsWith('jasper-') && k !== SHELL_CACHE && k !== ASSETS_CACHE)
						.map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trimCache(name, max) {
	const cache = await caches.open(name);
	const keys = await cache.keys();
	for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function networkFirstNavigation(request) {
	try {
		const res = await fetch(request);
		if (res.ok) {
			const copy = res.clone();
			caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
		}
		return res;
	} catch {
		const cached = await caches.match('/index.html');
		return cached || Response.error();
	}
}

async function cacheFirst(request) {
	const cached = await caches.match(request);
	if (cached) return cached;
	try {
		const res = await fetch(request);
		if (res.ok && res.status === 200) {
			const copy = res.clone();
			caches
				.open(ASSETS_CACHE)
				.then((c) => c.put(request, copy))
				.then(() => trimCache(ASSETS_CACHE, ASSETS_MAX_ENTRIES));
		}
		return res;
	} catch {
		return Response.error();
	}
}

async function networkFirst(request) {
	try {
		const res = await fetch(request);
		if (res.ok && res.status === 200) {
			const copy = res.clone();
			caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
		}
		return res;
	} catch {
		const cached = await caches.match(request);
		return cached || Response.error();
	}
}

self.addEventListener('fetch', (event) => {
	const request = event.request;
	const route = classifyRequest({
		url: request.url,
		method: request.method,
		mode: request.mode,
		hasRange: request.headers.has('range'),
		origin: self.location.origin,
	});
	if (route === 'bypass') return; // the browser handles it (streaming, Range, engine auth)
	if (route === 'navigate') event.respondWith(networkFirstNavigation(request));
	else if (route === 'asset') event.respondWith(cacheFirst(request));
	else event.respondWith(networkFirst(request));
});
