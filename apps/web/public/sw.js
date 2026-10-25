// JasperEditor service worker (ARCHITECTURE §12, S05:PWA-004/005, R-OMS §3.5/§8.3).
// Served as-is; pwa.test.ts exercises this script directly. Bump VERSION to invalidate the cached shell.

const VERSION = 'v2';
const SHELL_CACHE = `jasper-shell-${VERSION}`;
const ASSETS_CACHE = `jasper-assets-${VERSION}`;
const ASSETS_MAX_ENTRIES = 84;

// Generated at build time from the optional runtimes' static import closure. Registration happens after window
// load: warm their source for offline use here without downloading or evaluating them on the page's critical path.
try {
	importScripts('/editor-assets.js');
} catch {
	// A missing optional list must not prevent the worker from installing.
}

const BYPASS_PREFIXES = [
	'/api',
	'/events',
	'/agent',
	'/mcp',
	'/ws',
	'/health',
	'/media',
	'/mg',
	'/renders',
	'/pair',
];
const CACHE_FIRST_PREFIXES = ['/assets/', '/fonts/'];
const PRECACHE_URLS = [
	'/',
	'/index.html',
	'/theme-boot.js',
	'/editor-boot.js',
	'/manifest.webmanifest',
	'/icons/icon-192.png',
	'/icons/icon-512.png',
];

/** 'bypass' | 'navigate' | 'asset' | 'static'. */
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

self.addEventListener('install', (event) => {
	// Not cache.addAll: one missing file must not fail the whole install.
	event.waitUntil(
		caches.open(SHELL_CACHE).then(async (cache) => {
			await Promise.all(
				PRECACHE_URLS.map((url) =>
					fetch(url, { cache: 'reload' })
						.then((res) => (res.ok ? cache.put(url === '/' ? '/index.html' : url, res) : undefined))
						.catch(() => undefined),
				),
			);
			const assets = await caches.open(ASSETS_CACHE);
			// Sequential background requests leave bandwidth for the already running editor. One failed runtime
			// does not prevent the remaining ones or the shell from being available offline.
			for (const url of self.jasperEditorAssets ?? []) {
				try {
					const res = await fetch(url, { cache: 'force-cache' });
					if (res.ok) await assets.put(url, res);
				} catch {
					// The shell still installs if the network disappears during the warm-up.
				}
			}
			await trimCache(ASSETS_CACHE, ASSETS_MAX_ENTRIES);
		}),
	);
	// Let existing tabs finish with their current worker before this version activates.
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
