import { DERIVATIVE_KINDS } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorBootScript, optionalEditorChunks } from '../editor-boot.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { createMediaRuntimeSync } from '../src/import/media-runtime.ts';
import { fetchWithEarly } from '../src/state/engine.tsx';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => localStorage.clear());

const BOOT_RETRY_STORAGE_KEY = 'jasper:boot-retries';

function addMedia(session: EditorSession, n: number): { ids: string[]; keys: string[] } {
	const keys = Array.from({ length: n }, (_, i) => `mk_OPEN${String(i).padStart(6, '0')}`);
	const ids = keys.map(() => session.ctx.ids.next('med'));
	const r = session.apply({
		label: 'media',
		origin: 'user',
		commands: keys.map((key, i) => ({
			type: 'media.register',
			asset: buildMediaAsset(registered(`clip-${i}.mp4`, { key, fingerprint: `q1:${key}` }), {
				id: ids[i]!,
				now: 't',
			}),
		})) as never[],
	});
	if (!r.ok) throw new Error(r.errors[0]!.message);
	return { ids, keys };
}

/** A full derivative record (the API lists every kind). */
const derivatives = (over: Record<string, unknown> = {}) => ({
	...Object.fromEntries(DERIVATIVE_KINDS.map((k) => [k, { state: 'none', progress: 0 }])),
	...over,
});

const settled = (session: EditorSession) =>
	Object.values(session.getState().media).every((m) => m.availability !== 'resolving');

async function until(fn: () => boolean) {
	for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(fn()).toBe(true);
}

describe('media resolution at project open', () => {
	it('resolves every requested media status across bounded batches', async () => {
		const { session } = await memorySession();
		// ARCHITECTURE D-48 caps each request at 1,000 keys. This project needs more than one.
		const n = 1002;
		const { ids, keys } = addMedia(session, n);
		const engine = new ScriptedEngine().on((r) => {
			if (r.method !== 'POST' || r.path !== '/api/media/status') return undefined;
			const asked = (r.body as { mediaKeys: string[] }).mediaKeys;
			return {
				body: {
					statuses: asked
						.filter((k) => Number(k.slice(-1)) % 2 === 0)
						.map((mediaKey) => ({
							mediaKey,
							status: 'online',
							derivatives: derivatives({
								poster: { state: 'ready', progress: 1, url: `/media/${mediaKey}/poster.jpg` },
							}),
						})),
					unknown: asked.filter((k) => Number(k.slice(-1)) % 2 === 1),
				},
			};
		});
		const sync = createMediaRuntimeSync(session, engine.client(), null);
		await until(() => Object.keys(session.getState().media).length === n && settled(session));

		const batches = engine.requests
			.filter((r) => r.method === 'POST' && r.path === '/api/media/status')
			.map((r) => (r.body as { mediaKeys: string[] }).mediaKeys);
		expect(new Set(batches.flat())).toEqual(new Set(keys));
		for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(1000);
		const media = session.getState().media;
		for (const [i, id] of ids.entries())
			expect(media[id]).toMatchObject(
				i % 2 === 0
					? { availability: 'online', posterUrl: `/media/${keys[i]}/poster.jpg` }
					: { availability: 'offline' },
			);
		sync.dispose();
	});

	it('falls back to one request per medium on an engine without the batch route', async () => {
		const { session } = await memorySession();
		const { ids } = addMedia(session, 3);
		const engine = new ScriptedEngine().on((r) => {
			if (r.method === 'POST' && r.path === '/api/media/status')
				return { status: 404, body: { code: 'NOT_FOUND', message: 'Route not found', retryable: false } };
			const m = /^\/api\/media\/(mk_[A-Z0-9]+)$/.exec(r.path);
			if (m && r.method === 'GET')
				return {
					body: {
						mediaKey: m[1],
						status: 'online',
						derivatives: derivatives({ peaks: { state: 'ready', progress: 1 } }),
					},
				};
			return undefined;
		});
		const sync = createMediaRuntimeSync(session, engine.client(), null);
		await until(() => settled(session) && Object.keys(session.getState().media).length === 3);
		expect(
			engine.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/api/media/mk_')),
		).toHaveLength(3);
		for (const id of ids)
			expect(session.getState().media[id]).toMatchObject({
				availability: 'online',
				peaks: { state: 'ready' },
			});
		sync.dispose();
	});

	it('marks every medium as needing the engine when it cannot be reached', async () => {
		const { session } = await memorySession();
		const { ids } = addMedia(session, 4);
		const down = new EngineClient({
			fetch: (async () => {
				throw new TypeError('fetch failed');
			}) as unknown as typeof fetch,
		});
		const sync = createMediaRuntimeSync(session, down, null);
		await until(() => settled(session) && Object.keys(session.getState().media).length === 4);
		for (const id of ids) expect(session.getState().media[id]?.availability).toBe('needs-engine');
		sync.dispose();
	});
});

describe('editor boot script (preload + early project fetch)', () => {
	it('offline warm-up includes the optional runtimes and their static dependencies, with cycles bounded', () => {
		expect(
			optionalEditorChunks({
				pdf: { type: 'chunk', fileName: 'assets/vendor-pdf-a.js', imports: ['assets/shared.js'] },
				shared: { type: 'chunk', fileName: 'assets/shared.js', imports: ['assets/vendor-pdf-a.js'] },
				lottie: { type: 'chunk', fileName: 'assets/vendor-lottie-b.js' },
				panel: { type: 'chunk', fileName: 'assets/panel.js' },
				asset: { type: 'asset', fileName: 'assets/vendor-screenshot-c.js' },
			}),
		).toEqual(['/assets/shared.js', '/assets/vendor-lottie-b.js', '/assets/vendor-pdf-a.js']);
	});

	function boot(pathname: string, fetchImpl: (url: string) => Promise<unknown>) {
		const links: { rel: string; href: string }[] = [];
		const win: Record<string, unknown> = { addEventListener: () => undefined };
		const script = editorBootScript(['/assets/EditorShell.js', '/assets/dock.js']);
		new Function('location', 'document', 'window', 'fetch', script)(
			{ pathname },
			{
				createElement: () => ({ rel: '', href: '' }),
				head: { appendChild: (l: { rel: string; href: string }) => links.push(l) },
			},
			win,
			fetchImpl,
		);
		return { links, early: win.__jasperEarly as { url: string; response: Promise<unknown> } | undefined };
	}

	it('on an editor URL preloads the chunks and starts fetching the project; elsewhere it does nothing', async () => {
		const asked: string[] = [];
		const ok = (url: string) => {
			asked.push(url);
			return Promise.resolve('answer');
		};
		const editor = boot('/project/prj_AB%20C', ok);
		expect(editor.links.map((l) => `${l.rel} ${l.href}`)).toEqual([
			'modulepreload /assets/EditorShell.js',
			'modulepreload /assets/dock.js',
		]);
		expect(editor.early?.url).toBe('/api/projects/prj_AB%20C');
		expect(asked).toEqual(['/api/projects/prj_AB%20C']);
		expect(await editor.early?.response).toBe('answer');

		for (const path of ['/', '/project/demo', '/projects/x', '/project/%E0%A4%A']) {
			const r = boot(path, ok);
			expect(r.early, path).toBeUndefined();
		}
		expect(boot('/', ok).links).toEqual([]);
		const failing = boot('/project/p1', () => Promise.reject(new Error('down')));
		await expect(failing.early?.response).rejects.toThrow('down');
	});

	it('says so when the bundle cannot be downloaded, instead of a blank page', () => {
		document.body.innerHTML = '<div id="root"></div>';
		window.sessionStorage.setItem(BOOT_RETRY_STORAGE_KEY, JSON.stringify({ fast: 3, total: 8 }));
		const root = document.getElementById('root')!;
		const listeners: EventListener[] = [];
		const add = window.addEventListener.bind(window);
		const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((
			type: string,
			fn: EventListener,
			opts?: boolean,
		) => {
			if (type === 'error') listeners.push(fn);
			add(type, fn, opts);
		}) as typeof window.addEventListener);
		try {
			new Function(editorBootScript([]))();
		} finally {
			spy.mockRestore();
		}
		try {
			const fail = (el: HTMLElement) => {
				document.body.appendChild(el);
				el.dispatchEvent(new Event('error'));
			};
			fail(document.createElement('img'));
			fail(document.createElement('script'));
			expect(root.childElementCount).toBe(0);

			const entry = document.createElement('script');
			entry.type = 'module';
			window.localStorage.setItem('jasper:gaps-prefs', JSON.stringify({ appearance: { language: 'es' } }));
			fail(entry);
			const alert = root.querySelector('[role="alert"][data-testid="app-load-error"]');
			expect(alert).not.toBeNull();
			expect(alert?.textContent?.trim()).toBeTruthy();
			expect(document.activeElement).toBe(alert?.querySelector('button'));

			fail(entry);
			expect(root.querySelectorAll('[data-testid="app-load-error"]')).toHaveLength(1);

			for (const stored of [null, '{broken']) {
				root.innerHTML = '';
				if (stored === null) window.localStorage.removeItem('jasper:gaps-prefs');
				else window.localStorage.setItem('jasper:gaps-prefs', stored);
				fail(entry);
				expect(root.querySelector('[role="alert"] button')).not.toBeNull();
			}
		} finally {
			for (const fn of listeners) window.removeEventListener('error', fn, true);
			window.localStorage.removeItem('jasper:gaps-prefs');
			window.sessionStorage.removeItem(BOOT_RETRY_STORAGE_KEY);
			document.body.innerHTML = '';
		}
	});

	it('reloads by itself first: fast failures have a small budget, slow cut-off loads a larger one, a boot resets it', async () => {
		// Network-interface changes can abort all module requests mid-load; a reload must recover.
		vi.useFakeTimers();
		const reload = vi.fn();
		const realLocation = window.location;
		Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
		const listeners: EventListener[] = [];
		const add = window.addEventListener.bind(window);
		const stored = () => JSON.parse(window.sessionStorage.getItem(BOOT_RETRY_STORAGE_KEY) ?? 'null');
		/** A fresh page: the boot script runs; then, `at` ms after the navigation, every module fails. */
		const page = async (at: number | null) => {
			for (const fn of listeners.splice(0)) window.removeEventListener('error', fn, true);
			document.body.innerHTML = '<div id="root"></div>';
			reload.mockClear();
			const spy = vi.spyOn(window, 'addEventListener').mockImplementation(((
				type: string,
				fn: EventListener,
				opts?: boolean,
			) => {
				if (type === 'error') listeners.push(fn);
				add(type, fn, opts);
			}) as typeof window.addEventListener);
			try {
				new Function(editorBootScript([]))();
			} finally {
				spy.mockRestore();
			}
			const root = document.getElementById('root')!;
			if (at === null) return { root, reloaded: false, message: false };
			const now = vi.spyOn(performance, 'now').mockReturnValue(at);
			try {
				for (let i = 0; i < 3; i++) {
					const entry = document.createElement('script');
					entry.type = 'module';
					document.body.appendChild(entry);
					entry.dispatchEvent(new Event('error'));
				}
			} finally {
				now.mockRestore();
			}
			const message = root.querySelector('[data-testid="app-load-error"]') !== null;
			await vi.advanceTimersByTimeAsync(2000);
			return { root, reloaded: reload.mock.calls.length > 0, message };
		};
		try {
			window.sessionStorage.removeItem(BOOT_RETRY_STORAGE_KEY);
			// docs/verification.md §8: three quick retries, eight total, slow after eight seconds.
			for (let i = 0; i < 3; i++) {
				expect(await page(100)).toMatchObject({ reloaded: true, message: false });
				expect(reload).toHaveBeenCalledTimes(1);
			}
			expect(await page(100)).toMatchObject({ reloaded: false, message: true });
			// a slow load cut off midway was making progress: it is reloaded although the quick budget is spent
			expect(await page(8001)).toMatchObject({ reloaded: true, message: false });
			for (let total = 5; total <= 8; total++)
				expect(await page(16_000)).toMatchObject({ reloaded: true, message: false });
			expect(await page(16_000)).toMatchObject({ reloaded: false, message: true });
			const { root } = await page(null);
			root.appendChild(document.createElement('main'));
			await vi.advanceTimersByTimeAsync(0);
			expect(stored()).toBeNull();
			window.sessionStorage.setItem(BOOT_RETRY_STORAGE_KEY, '{"fast":"x","total":-4}');
			expect(await page(100)).toMatchObject({ reloaded: true, message: false });
		} finally {
			for (const fn of listeners) window.removeEventListener('error', fn, true);
			Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
			window.sessionStorage.removeItem(BOOT_RETRY_STORAGE_KEY);
			document.body.innerHTML = '';
			vi.useRealTimers();
		}
	});

	it('the engine client takes the early answer once, for exactly that GET, and asks again when it failed', async () => {
		const w = window as unknown as {
			__jasperEarly?: { url: string; response: Promise<Response>; at: number };
		};
		const real = vi.fn(async () => new Response('real'));
		const f = fetchWithEarly(real as unknown as typeof fetch);
		const early = () => ({
			url: '/api/projects/p1',
			response: Promise.resolve(new Response('early')),
			at: Date.now(),
		});

		w.__jasperEarly = early();
		expect(await (await f('/api/projects/p2')).text()).toBe('real');
		expect(await (await f('/api/projects/p1', { method: 'PUT' })).text()).toBe('real');
		expect(w.__jasperEarly).toBeDefined();
		expect(await (await f('/api/projects/p1')).text()).toBe('early');
		expect(w.__jasperEarly).toBeUndefined();
		expect(await (await f('/api/projects/p1')).text()).toBe('real');

		w.__jasperEarly = { ...early(), response: Promise.reject(new Error('down')) };
		w.__jasperEarly.response.catch(() => undefined);
		expect(await (await f('/api/projects/p1')).text()).toBe('real');

		w.__jasperEarly = { ...early(), at: Date.now() - 60_000 };
		expect(await (await f('/api/projects/p1')).text()).toBe('real');
		expect(w.__jasperEarly).toBeUndefined();
	});
});
