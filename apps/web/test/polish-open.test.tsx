// polish: opening a project resolves its media with one status request per batch and one store update per answer
// (a 2 000-item project used to send 2 000 requests and re-run every subscriber once per answer).
import { DERIVATIVE_KINDS, MEDIA_STATUS_BATCH_MAX } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import type { EditorSession } from '@jasper/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorBootScript, editorChunks } from '../editor-boot.ts';
import { buildMediaAsset } from '../src/import/assets.ts';
import { createMediaRuntimeSync } from '../src/import/media-runtime.ts';
import { fetchWithEarly } from '../src/state/engine.tsx';
import { memorySession, registered, ScriptedEngine } from './wp2e/helpers.ts';

afterEach(() => localStorage.clear());

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
	it('asks for every status in batches and updates the store once per answer', async () => {
		const { session } = await memorySession();
		const n = MEDIA_STATUS_BATCH_MAX + 200;
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
		let updates = 0;
		const off = session.store.subscribe(() => updates++);
		const sync = createMediaRuntimeSync(session, engine.client(), null);
		await until(() => Object.keys(session.getState().media).length === n && settled(session));
		off();

		const status = engine.requests.filter((r) => r.path.startsWith('/api/media/'));
		expect(status.map((r) => `${r.method} ${r.path}`)).toEqual([
			'POST /api/media/status',
			'POST /api/media/status',
		]);
		expect((status[0]!.body as { mediaKeys: string[] }).mediaKeys).toHaveLength(MEDIA_STATUS_BATCH_MAX);
		expect((status[1]!.body as { mediaKeys: string[] }).mediaKeys).toHaveLength(200);
		// one update marking everything "resolving", one per answer (plus the interpreted-picture / poster sweeps)
		expect(updates).toBeLessThanOrEqual(6);
		const media = session.getState().media;
		expect(media[ids[0]!]).toMatchObject({
			availability: 'online',
			posterUrl: `/media/${keys[0]}/poster.jpg`,
		});
		expect(media[ids[1]!]).toMatchObject({ availability: 'offline' });
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
	const bundle = {
		'assets/index.js': {
			type: 'chunk',
			fileName: 'assets/index.js',
			isEntry: true,
			imports: ['assets/vendor.js'],
		},
		'assets/vendor.js': { type: 'chunk', fileName: 'assets/vendor.js', imports: [] },
		'assets/EditorShell.js': {
			type: 'chunk',
			fileName: 'assets/EditorShell.js',
			isDynamicEntry: true,
			facadeModuleId: '/repo/apps/web/src/shell/EditorShell.tsx',
			imports: ['assets/vendor.js', 'assets/dock.js'],
		},
		'assets/dock.js': { type: 'chunk', fileName: 'assets/dock.js', imports: ['assets/vendor.js'] },
		'assets/TimelinePanel.js': {
			type: 'chunk',
			fileName: 'assets/TimelinePanel.js',
			isDynamicEntry: true,
			facadeModuleId: 'C:\\repo\\apps\\web\\src\\panels\\timeline\\TimelinePanel.tsx',
			imports: ['assets/ClipView.js'],
		},
		'assets/ClipView.js': { type: 'chunk', fileName: 'assets/ClipView.js', imports: [] },
		'assets/pdf.js': {
			type: 'chunk',
			fileName: 'assets/pdf.js',
			isDynamicEntry: true,
			facadeModuleId: '/repo/node_modules/pdfjs/build/pdf.mjs',
			imports: [],
		},
		'assets/index.css': { type: 'asset', fileName: 'assets/index.css' },
	};

	it('lists the shell, the panel bodies and what they import — not the entry’s own chunks or other lazy code', () => {
		expect(editorChunks(bundle)).toEqual([
			'/assets/ClipView.js',
			'/assets/EditorShell.js',
			'/assets/TimelinePanel.js',
			'/assets/dock.js',
		]);
	});

	function boot(pathname: string, fetchImpl: (url: string) => Promise<unknown>) {
		const links: { rel: string; href: string }[] = [];
		const win: Record<string, unknown> = {};
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
		// a failing early request is not an unhandled rejection
		const failing = boot('/project/p1', () => Promise.reject(new Error('down')));
		await expect(failing.early?.response).rejects.toThrow('down');
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
		expect(await (await f('/api/projects/p2')).text()).toBe('real'); // another URL: untouched
		expect(await (await f('/api/projects/p1', { method: 'PUT' })).text()).toBe('real');
		expect(w.__jasperEarly).toBeDefined();
		expect(await (await f('/api/projects/p1')).text()).toBe('early');
		expect(w.__jasperEarly).toBeUndefined();
		expect(await (await f('/api/projects/p1')).text()).toBe('real'); // only once

		w.__jasperEarly = { ...early(), response: Promise.reject(new Error('down')) };
		w.__jasperEarly.response.catch(() => undefined);
		expect(await (await f('/api/projects/p1')).text()).toBe('real');

		w.__jasperEarly = { ...early(), at: Date.now() - 60_000 }; // stale: asked again
		expect(await (await f('/api/projects/p1')).text()).toBe('real');
		expect(w.__jasperEarly).toBeUndefined();
	});
});
