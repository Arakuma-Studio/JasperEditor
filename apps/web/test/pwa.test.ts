import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../src/pwa/register.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const ORIGIN = 'http://127.0.0.1:47900';

function worker(optional: string[] = []) {
	const handlers = new Map<string, (event: unknown) => void>();
	const fetch = vi.fn().mockRejectedValue(new Error('Offline'));
	const stores = new Map<string, Map<string, Response>>();
	const cacheKey = (request: Request | string) =>
		new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
	const caches = {
		match: async (request: Request | string) => {
			for (const store of stores.values()) {
				const response = store.get(cacheKey(request));
				if (response) return response.clone();
			}
		},
		open: vi.fn(async (name: string) => {
			let store = stores.get(name);
			if (!store) {
				store = new Map();
				stores.set(name, store);
			}
			return {
				put: async (request: Request | string, response: Response) => {
					store.set(cacheKey(request), response.clone());
				},
				keys: async () => [...store.keys()].map((url) => new Request(url)),
				delete: async (request: Request | string) => store.delete(cacheKey(request)),
			};
		}),
	};
	const self = {
		addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
		location: { origin: ORIGIN },
		jasperEditorAssets: optional,
	};
	runInNewContext(readFileSync(join(__dirname, '../public/sw.js'), 'utf8'), {
		self,
		importScripts: () => undefined,
		URL,
		caches,
		fetch,
		Response,
	});
	return { handlers, fetch, caches };
}

describe('service worker fetch contract (S05:PWA-004)', () => {
	it('warms optional runtimes for offline use and still installs if one cannot be downloaded', async () => {
		const sw = worker(['/assets/vendor-pdf-a.js', '/assets/vendor-quickjs-b.js']);
		sw.fetch.mockImplementation(async (url: string) => {
			if (url.endsWith('vendor-pdf-a.js')) throw new Error('Unavailable');
			return new Response(url === '/' || url === '/index.html' ? '<main>Editor</main>' : 'runtime source');
		});
		const waitUntil = vi.fn();
		sw.handlers.get('install')!({ waitUntil });
		await waitUntil.mock.calls[0]![0];
		sw.fetch.mockRejectedValue(new Error('Offline'));
		const fetchOffline = async (path: string) => {
			const respondWith = vi.fn();
			sw.handlers.get('fetch')!({ request: new Request(`${ORIGIN}${path}`), respondWith });
			return (await respondWith.mock.calls[0]![0]) as Response;
		};
		expect(await (await fetchOffline('/assets/vendor-quickjs-b.js')).text()).toBe('runtime source');
		expect((await fetchOffline('/assets/vendor-pdf-a.js')).type).toBe('error');
		expect(await (await fetchOffline('/index.html')).text()).toBe('<main>Editor</main>');
	});

	it.each([
		['Range seek', `${ORIGIN}/assets/index.js`, 'GET', { Range: 'bytes=0-99' }],
		['media proxy', `${ORIGIN}/media/mk_1/proxy/720`, 'GET', {}],
		['render download', `${ORIGIN}/renders/job_1/output`, 'GET', {}],
		['cross-origin font', 'https://fonts.gstatic.com/s/x.woff2', 'GET', {}],
		['non-GET request', `${ORIGIN}/assets/index.js`, 'POST', {}],
	] as const)('leaves %s outside its cache', (_name, url, method, headers) => {
		const sw = worker();
		const respondWith = vi.fn();
		sw.handlers.get('fetch')!({
			request: new Request(url, { method, headers }),
			respondWith,
		});
		expect(respondWith).not.toHaveBeenCalled();
		expect(sw.caches.open).not.toHaveBeenCalled();
		expect(sw.fetch).not.toHaveBeenCalled();
	});

	it('returns a network error for an uncached asset while offline', async () => {
		const sw = worker();
		const respondWith = vi.fn();
		sw.handlers.get('fetch')!({
			request: new Request(`${ORIGIN}/assets/missing.js`),
			respondWith,
		});
		const response = await respondWith.mock.calls[0]![0];
		expect(response.type).toBe('error');
	});
});

describe('registration gating (S05:PWA-004)', () => {
	it('registers only in production web builds with service-worker support', () => {
		const register = vi.fn().mockResolvedValue({ waiting: null, addEventListener: vi.fn() });
		vi.stubGlobal('navigator', { serviceWorker: { addEventListener: vi.fn(), register } });
		vi.stubGlobal('document', { readyState: 'complete' });
		vi.stubEnv('PROD', false);
		registerServiceWorker();
		vi.stubEnv('PROD', true);
		vi.stubGlobal('window', { jasperDesktop: {} });
		registerServiceWorker();
		vi.stubGlobal('window', {});
		vi.stubGlobal('navigator', {});
		registerServiceWorker();
		expect(register).not.toHaveBeenCalled();
		vi.stubGlobal('navigator', { serviceWorker: { addEventListener: vi.fn(), register } });
		registerServiceWorker();
		expect(register).toHaveBeenCalledExactlyOnceWith('/sw.js');
	});
});
