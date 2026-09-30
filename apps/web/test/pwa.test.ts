// PWA (WP-2H, ARCHITECTURE §12, S05:PWA-001/004): route classifier (bypass media/API/Range), equivalence
// with public/sw.js, manifest with separate maskable icons, registration gating.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { shouldRegisterServiceWorker } from '../src/pwa/register.ts';
import {
	ASSETS_CACHE,
	BYPASS_PREFIXES,
	CACHE_FIRST_PREFIXES,
	classifyRequest,
	PRECACHE_URLS,
	SHELL_CACHE,
	type SwRequestInfo,
	type SwRoute,
} from '../src/pwa/sw-routes.ts';

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
	const self: Record<string, unknown> = { addEventListener: () => undefined, location: { origin: ORIGIN } };
	runInNewContext(readFileSync(join(PUBLIC, 'sw.js'), 'utf8'), {
		self,
		URL,
		caches: {},
		fetch: () => undefined,
		Response,
	});
	return self.__jasperSw as {
		classifyRequest(r: SwRequestInfo): SwRoute;
		VERSION: string;
		SHELL_CACHE: string;
		ASSETS_CACHE: string;
		BYPASS_PREFIXES: string[];
		CACHE_FIRST_PREFIXES: string[];
		PRECACHE_URLS: string[];
	};
}

describe('service worker route classifier (S05:PWA-004)', () => {
	it.each(CASES)('%j → %s', (req, route) => {
		expect(classifyRequest(req)).toBe(route);
	});

	it('public/sw.js classifies exactly like sw-routes.ts and uses the same caches and lists', () => {
		const sw = loadSw();
		for (const [req] of CASES) expect(sw.classifyRequest(req), req.url).toBe(classifyRequest(req));
		// Every prefix × mode × method × range combination.
		for (const p of [...BYPASS_PREFIXES, ...CACHE_FIRST_PREFIXES, '/', '/x', '/project/1'])
			for (const mode of ['navigate', 'cors', 'no-cors', undefined])
				for (const method of ['GET', 'HEAD', 'POST'])
					for (const hasRange of [false, true]) {
						const req = get(`${p}${p.endsWith('/') ? 'a' : '/a'}`, { mode, method, hasRange });
						expect(sw.classifyRequest(req)).toBe(classifyRequest(req));
					}
		expect(sw.SHELL_CACHE).toBe(SHELL_CACHE);
		expect(sw.ASSETS_CACHE).toBe(ASSETS_CACHE);
		expect(SHELL_CACHE).toMatch(/^jasper-shell-v\d+$/);
		expect(ASSETS_CACHE).toMatch(/^jasper-assets-v\d+$/);
		expect([...sw.BYPASS_PREFIXES]).toEqual([...BYPASS_PREFIXES]);
		expect([...sw.CACHE_FIRST_PREFIXES]).toEqual([...CACHE_FIRST_PREFIXES]);
		expect([...sw.PRECACHE_URLS]).toEqual([...PRECACHE_URLS]);
	});

	it('answers misses with Response.error() and never caches Range requests', () => {
		const src = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
		expect(src).toContain('Response.error()');
		expect(src).not.toContain('addAll(');
		expect(src).toContain("request.headers.has('range')");
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
