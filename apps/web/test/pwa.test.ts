// PWA (WP-2H, ARCHITECTURE §12, S05:PWA-001/004): route classifier (bypass media/API/Range)
// in the shipped public/sw.js, manifest with separate maskable icons, registration gating.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { shouldRegisterServiceWorker } from '../src/pwa/register.ts';

type SwRoute = 'bypass' | 'navigate' | 'asset' | 'static';
type SwRequestInfo = { url: string; method: string; origin: string; mode?: string; hasRange?: boolean };

const ORIGIN = 'http://127.0.0.1:47900';
const PUBLIC = join(__dirname, '../public');
const get = (path: string, extra: Partial<SwRequestInfo> = {}): SwRequestInfo => ({
	url: path.includes(':') ? path : `${ORIGIN}${path}`,
	method: 'GET',
	origin: ORIGIN,
	...extra,
});

const CASES: [SwRequestInfo, SwRoute][] = [
	[get('/api/projects'), 'bypass'],
	[get('/api'), 'bypass'],
	[get('/events?since=4'), 'bypass'],
	[get('/agent'), 'bypass'],
	[get('/mcp'), 'bypass'],
	[get('/mcp/tools'), 'bypass'],
	[get('/ws/anything'), 'bypass'],
	[get('/health'), 'bypass'],
	[get('/media/mk_1'), 'bypass'],
	[get('/media/mk_1/proxy/720'), 'bypass'],
	[get('/media/mk_1/poster.jpg'), 'bypass'],
	[get('/media/mk_1/sprite/0.jpg'), 'bypass'],
	[get('/media/mk_1/peaks/0.bin'), 'bypass'],
	[get('/mg/key/preview.webm'), 'bypass'],
	[get('/renders/job_1/output'), 'bypass'],
	[get('/assets/index-abc.js', { hasRange: true }), 'bypass'],
	[get('/', { mode: 'navigate', hasRange: true }), 'bypass'],
	[get('/assets/index-abc.js', { method: 'POST' }), 'bypass'],
	[get('blob:http://127.0.0.1:47900/5f0c'), 'bypass'],
	[get('data:text/plain,hi'), 'bypass'],
	[get('https://fonts.gstatic.com/s/x.woff2'), 'bypass'],
	[get('http://127.0.0.1:5173/assets/x.js'), 'bypass'],
	[get('/', { mode: 'navigate' }), 'navigate'],
	[get('/project/prj_1', { mode: 'navigate' }), 'navigate'],
	[get('/assets/index-abc.js'), 'asset'],
	[get('/assets/index-abc.css'), 'asset'],
	[get('/fonts/inter/400.woff2'), 'asset'],
	[get('/manifest.webmanifest'), 'static'],
	[get('/icons/icon-192.png'), 'static'],
	[get('/theme-boot.js'), 'static'],
	[get('/apiary'), 'static'],
	[get('/mediation/x.png'), 'static'],
];

function loadSw() {
	const handlers = new Map<string, (event: unknown) => void>();
	const put = vi.fn();
	const fetch = vi.fn().mockRejectedValue(new Error('Offline'));
	const caches = { match: vi.fn().mockResolvedValue(undefined), open: vi.fn().mockResolvedValue({ put }) };
	const self = {
		addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
		location: { origin: ORIGIN },
	};
	const sw = runInNewContext(
		`${readFileSync(join(PUBLIC, 'sw.js'), 'utf8')}\n({ classifyRequest, SHELL_CACHE, PRECACHE_URLS })`,
		{ self, URL, caches, fetch, Response },
	) as {
		classifyRequest(r: SwRequestInfo): SwRoute;
		SHELL_CACHE: string;
		PRECACHE_URLS: string[];
	};
	return { ...sw, handlers, fetch, caches, put };
}

describe('service worker routing and caching (S05:PWA-004)', () => {
	const sw = loadSw();
	it.each(CASES)('%j → %s', (req, route) => {
		expect(sw.classifyRequest(req)).toBe(route);
	});

	it('bypasses Range requests at the fetch handler', () => {
		const respondWith = vi.fn();
		sw.handlers.get('fetch')!({
			request: new Request(`${ORIGIN}/assets/index.js`, { headers: { Range: 'bytes=0-99' } }),
			respondWith,
		});
		expect(respondWith).not.toHaveBeenCalled();
		expect(sw.fetch).not.toHaveBeenCalled();
		expect(sw.caches.open).not.toHaveBeenCalled();
	});

	it.each(['/assets/missing.js', '/manifest.webmanifest', '/project/prj_1'])(
		'answers an offline cache miss with a network error: %s',
		async (path) => {
			const worker = loadSw();
			const respondWith = vi.fn();
			worker.handlers.get('fetch')!({
				request: {
					url: `${ORIGIN}${path}`,
					method: 'GET',
					headers: new Headers(),
					mode: path.startsWith('/project') ? 'navigate' : 'cors',
				},
				respondWith,
			});
			const response = await respondWith.mock.calls[0]![0];
			expect(response.type).toBe('error');
			expect(worker.put).not.toHaveBeenCalled();
		},
	);

	it('precaches available shell files even when another file fails', async () => {
		const worker = loadSw();
		worker.fetch.mockImplementation(async (url: string) => {
			if (url === '/icons/icon-192.png') throw new Error('Missing icon');
			return new Response('shell');
		});
		const waitUntil = vi.fn();
		worker.handlers.get('install')!({ waitUntil });
		await waitUntil.mock.calls[0]![0];
		expect(worker.caches.open).toHaveBeenCalledWith(worker.SHELL_CACHE);
		expect(worker.put).toHaveBeenCalledWith('/index.html', expect.any(Response));
		expect(worker.put).toHaveBeenCalledTimes(worker.PRECACHE_URLS.length - 1);
	});
});

describe('manifest (S05:PWA-001)', () => {
	const manifest = JSON.parse(readFileSync(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
	it('is standalone with WCO, colors and .jasper file handling', () => {
		expect(manifest).toMatchObject({
			name: 'JasperEditor',
			short_name: 'JasperEditor',
			display: 'standalone',
			display_override: ['window-controls-overlay', 'standalone'],
			orientation: 'any',
			background_color: '#000000',
			theme_color: '#1d1d1d',
		});
		expect(manifest.file_handlers[0].accept['application/x-jasper-project']).toEqual(['.jasper']);
	});
	it('ships 192/512 icons and SEPARATE maskable icons that exist on disk', () => {
		const any = manifest.icons.filter((i: { purpose: string }) => i.purpose === 'any');
		const mask = manifest.icons.filter((i: { purpose: string }) => i.purpose === 'maskable');
		expect(any.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
		expect(mask.map((i: { sizes: string }) => i.sizes)).toEqual(['192x192', '512x512']);
		const anySrc = new Set(any.map((i: { src: string }) => i.src));
		for (const icon of manifest.icons) {
			const file = join(PUBLIC, icon.src);
			expect(existsSync(file), icon.src).toBe(true);
			const png = readFileSync(file);
			expect(png.subarray(1, 4).toString()).toBe('PNG');
			const [w, h] = icon.sizes.split('x').map(Number);
			expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
			if (icon.purpose === 'maskable') expect(anySrc.has(icon.src)).toBe(false);
		}
	});
});

describe('registration gating (ARCHITECTURE §12)', () => {
	it('registers only in production web builds with service-worker support', () => {
		expect(shouldRegisterServiceWorker({ prod: true, desktop: false, supported: true })).toBe(true);
		expect(shouldRegisterServiceWorker({ prod: false, desktop: false, supported: true })).toBe(false);
		expect(shouldRegisterServiceWorker({ prod: true, desktop: true, supported: true })).toBe(false);
		expect(shouldRegisterServiceWorker({ prod: true, desktop: false, supported: false })).toBe(false);
	});
});
