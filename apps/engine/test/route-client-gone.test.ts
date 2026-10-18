// Routes that do long work inside the request (no job) and stop it when the client goes away, over a REAL connection
// (`app.inject` does not show the difference; wp-note "Phase 6 → final carry-over cleanup", item 4): the request
// stream's 'close' fires once its body has been read — listening to it cancelled every analysis that started at once
// (the beats route before WP-E7), and attached after an await it never fires again, so a client that left was never
// noticed (the visual route). The work must see its signal unaborted while the client waits, and aborted soon after the
// client closes its socket. Each route's work is replaced by a stub that holds until its signal aborts (or 3 s pass).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import { makeEnvelope } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';

type Seen = { aborted: boolean; abortedAfterMs: number | null };
const hooks = vi.hoisted(() => ({
	/** 'answer': the stub returns after 200 ms; 'hold': it waits for its signal to abort (≤ 3 s). */
	mode: 'answer' as 'answer' | 'hold',
	entered: null as null | (() => void),
	seen: [] as { aborted: boolean; abortedAfterMs: number | null }[],
	async work(signal: AbortSignal | undefined): Promise<void> {
		hooks.entered?.();
		const t0 = Date.now();
		const seen: { aborted: boolean; abortedAfterMs: number | null } = {
			aborted: false,
			abortedAfterMs: null,
		};
		hooks.seen.push(seen);
		const limit = hooks.mode === 'answer' ? 200 : 3000;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, limit);
			signal?.addEventListener('abort', () => {
				seen.aborted = true;
				seen.abortedAfterMs = Date.now() - t0;
				clearTimeout(timer);
				resolve();
			});
		});
		seen.aborted = signal?.aborted ?? false;
	},
}));

vi.mock('../src/sound-design/visual.ts', async (orig) => {
	const m = await orig<typeof import('../src/sound-design/visual.ts')>();
	return {
		...m,
		soundVisual: async (...args: Parameters<typeof m.soundVisual>) => {
			await hooks.work(args[3]?.signal);
			return { stub: 'visual' };
		},
	};
});
vi.mock('../src/sound-design/beds.ts', async (orig) => {
	const m = await orig<typeof import('../src/sound-design/beds.ts')>();
	return {
		...m,
		planBeds: async (...args: Parameters<typeof m.planBeds>) => {
			await hooks.work(args[5]?.signal);
			return { plan: { stub: 'beds' } } as never;
		},
		planRoomTone: async (...args: Parameters<typeof m.planRoomTone>) => {
			await hooks.work(args[5]?.signal);
			return { plan: { stub: 'room-tone' } } as never;
		},
	};
});

let app: TestApp;
let port = 0;
let projectId = '';
let mediaKey = '';

/** A POST over a real socket (the engine's allowed Host header); `destroy()` closes it before the answer. */
function post(
	path: string,
	body: unknown,
): { done: Promise<{ status: number; body: string }>; destroy(): void } {
	const req = request({
		host: '127.0.0.1',
		port,
		path,
		method: 'POST',
		headers: { host: '127.0.0.1:47900', 'content-type': 'application/json' },
	});
	const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
		req.on('response', (res) => {
			let text = '';
			res.setEncoding('utf8');
			res.on('data', (d: string) => {
				text += d;
			});
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
		});
		req.on('error', reject);
	});
	req.end(JSON.stringify(body));
	return { done, destroy: () => req.destroy() };
}

const ROUTES: { name: string; path: string; body: () => unknown; patch?: () => void }[] = [
	{
		name: 'POST /api/sound-design/visual',
		path: '/api/sound-design/visual',
		body: () => ({ projectId, range: { start: 0, end: 30 } }),
	},
	{
		name: 'POST /api/sound-design/beds/plan',
		path: '/api/sound-design/beds/plan',
		body: () => ({ projectId }),
	},
	{
		name: 'POST /api/sound-design/room-tone/plan',
		path: '/api/sound-design/room-tone/plan',
		body: () => ({ projectId }),
	},
	{
		name: 'POST /api/audio/beats',
		path: '/api/audio/beats',
		body: () => ({ mediaKey, startSeconds: 0, durationSeconds: 1 }),
	},
	{
		name: 'POST /api/sync/audio',
		path: '/api/sync/audio',
		body: () => ({
			clips: [
				{ key: 'a', mediaKey },
				{ key: 'b', mediaKey },
			],
		}),
	},
];

beforeAll(async () => {
	app = await makeApp();
	// the engine's own work of the two non-mocked routes, replaced on the service instances the routes call
	const services = app.jasper.services as {
		beats?: { analyze(req: unknown, signal?: AbortSignal): Promise<unknown> };
		sync?: { analyse(req: unknown, signal?: AbortSignal): Promise<unknown> };
	};
	services.beats!.analyze = async (_req, signal) => {
		await hooks.work(signal);
		return { stub: 'beats' };
	};
	services.sync!.analyse = async (_req, signal) => {
		await hooks.work(signal);
		return { stub: 'sync' };
	};
	const dir = mkdtempSync(join(tmpdir(), 'jasper-client-gone-'));
	const x = new Float32Array(48_000);
	writeFileSync(join(dir, 'tone.wav'), encodeWav([x, x], 48_000, 's16'));
	const reg = await register(app, join(dir, 'tone.wav'));
	mediaKey = reg.mediaKey;
	const b = new DocBuilder('hd-1080p-30', 4242);
	const mediaId = b.addMedia(reg);
	b.tx([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: 'A1' } }]);
	projectId = 'prj_00000000000000C1';
	const file = appdirPaths(app.appdir).projectFile(projectId);
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify(
			makeEnvelope(
				{ ...b.doc, projectId },
				{ revision: 1, savedAt: '2026-10-18T00:00:00.000Z', platform: 'test' },
			),
		),
	);
	await app.listen({ host: '127.0.0.1', port: 0 });
	port = (app.server.address() as AddressInfo).port;
	expect(coreServices(app).registry.get(mediaKey)).toBeTruthy();
}, 120_000);
afterAll(closeApps);

describe('long route work and the client, over a real connection', () => {
	for (const r of ROUTES) {
		it(`${r.name}: answered while the client waits (the work's signal is not aborted)`, async () => {
			hooks.mode = 'answer';
			hooks.seen = [];
			const res = await post(r.path, r.body()).done;
			expect(res.status, res.body).toBe(200);
			expect(hooks.seen).toHaveLength(1);
			expect(hooks.seen[0]).toEqual({ aborted: false, abortedAfterMs: null } satisfies Seen);
		});

		it(`${r.name}: cancelled when the client closes the connection`, async () => {
			hooks.mode = 'hold';
			hooks.seen = [];
			const entered = new Promise<void>((resolve) => {
				hooks.entered = resolve;
			});
			const call = post(r.path, r.body());
			call.done.catch(() => {});
			await entered;
			hooks.entered = null;
			await new Promise((resolve) => setTimeout(resolve, 50));
			call.destroy();
			await vi.waitFor(() => expect(hooks.seen[0]?.abortedAfterMs).not.toBeNull(), { timeout: 2500 });
			expect(hooks.seen[0]!.aborted).toBe(true);
			// it stopped at once (the hold would have lasted 3 s)
			expect(hooks.seen[0]!.abortedAfterMs!).toBeLessThan(1500);
		});
	}
});
