// The sound-design measurement worker threads (wp-note WP6.5b item 7; measure-pool.ts / measure-worker.ts): the solo and
// bed renders and their band analysis give BIT-IDENTICAL results on a worker and in-thread (the worker is bundled with
// esbuild, as the engine build does); the pool's lifecycle with fake workers: start failure → in-thread, a crash →
// MEASURE_FAILED (retryable, never a hung request), a timeout → MEASURE_TIMEOUT with the other requests moved to a new
// worker, cancel → JOB_CANCELLED at once and a worker that does not answer ended, idle workers stopped, at most `size`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MeasureCache, type MeasureDeps, measureSfxEvents } from '../src/sound-design/bed.ts';
import type { MeasureOp } from '../src/sound-design/measure-core.ts';
import {
	type MeasureWorkerRequest,
	type MeasureWorkerResponse,
	resolveMeasureWorker,
	SoundDesignMeasurer,
} from '../src/sound-design/measure-pool.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

async function bundleWorker(): Promise<string> {
	const { build } = await import('esbuild');
	const out = join(mkdtempSync(join(tmpdir(), 'jasper-sd-worker-')), 'sd-measure-worker.mjs');
	await build({
		entryPoints: [join(HERE, '..', 'src', 'sound-design', 'measure-worker.ts')],
		outfile: out,
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node20',
		logLevel: 'silent',
		external: ['@remotion/*', 'remotion', 'esbuild', 'fsevents', '*.node'],
		banner: {
			js: "import { createRequire as __r } from 'node:module'; const require = __r(import.meta.url);",
		},
	});
	return out;
}

describe('measurement worker threads: same results as in-thread (real engine, bundled worker)', {
	timeout: 600_000,
}, () => {
	let app: TestApp;
	let base: MeasureDeps;
	let doc: DocBuilder;
	const ids: Record<string, string> = {};
	let worker: SoundDesignMeasurer;
	const warnings: string[] = [];

	beforeAll(async () => {
		app = await makeApp();
		const core = coreServices(app);
		base = { ff: core.ffmpeg, registry: core.registry };
		const files = writeBedFixture(mkdtempSync(join(tmpdir(), 'jasper-sdw-')));
		const b = new DocBuilder('hd-1080p-30', 300);
		const music = b.addMedia(await register(app, files.music));
		const speech = b.addMedia(await register(app, files.speech));
		const hit = b.addMedia(await register(app, files.hit));
		const click = b.addMedia(await register(app, files.click));
		const r = b.tx([
			{ type: 'clip.place', source: { mediaId: music }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
			{ type: 'clip.place', source: { mediaId: speech }, at: 0, tracks: { audio: 'A2' }, ref: '$s' },
			{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
			{ type: 'essentialSound.setType', clipIds: ['$s'], audioType: 'dialogue' },
			{ type: 'media.setLibraryInfo', mediaId: hit, library: provenance('hit') },
			{ type: 'media.setLibraryInfo', mediaId: click, library: provenance('click') },
		]);
		ids.music = r.refs.$m!;
		const place = (frame: number, mediaId: string, role: string, key: string, extra: object = {}) => {
			ids[key] = b.tx([
				{ type: 'soundDesign.place', frame, layers: [{ mediaId, role, align: 'peak', ref: '$x', ...extra }] },
			]).refs.$x!;
		};
		place(30, hit, 'hero', 'hero');
		place(33, hit, 'support', 'shadowed', { rate: 0.98, pan: -40 });
		place(150, click, 'support', 'inSpeech');
		place(270, click, 'support', 'clear', { gainDb: -6 });
		doc = b;
		worker = new SoundDesignMeasurer(pathToFileURL(await bundleWorker()), (message) =>
			warnings.push(message),
		);
	}, 300_000);
	afterEach(() => {
		// A failed worker startup falls back successfully; parity alone must not hide a broken worker bundle.
		expect(warnings).toEqual([]);
	});
	afterAll(async () => {
		await worker?.close();
		await closeApps();
	});

	it('measureSfxEvents: every measurement and the bed clusters are equal, bit for bit', async () => {
		const targets = (['hero', 'shadowed', 'inSpeech', 'clear'] as const).map((k) => ({
			doc: doc.doc,
			clipId: ids[k]!,
			weight: k === 'hero' ? ('hero' as const) : ('support' as const),
		}));
		const input = { bedDoc: doc.doc, sequenceId: doc.seqId, targets };
		const thread = new SoundDesignMeasurer(null);
		const a = await measureSfxEvents(input, { ...base, cache: new MeasureCache(), measurer: thread });
		const b = await measureSfxEvents(input, { ...base, cache: new MeasureCache(), measurer: worker });
		expect(a.sounds.size).toBe(4);
		// Object.is on every number (toStrictEqual): bands, peaks, windows, true peaks
		expect([...b.sounds.entries()]).toStrictEqual([...a.sounds.entries()]);
		expect(b.clusters).toStrictEqual(a.clusters);
		expect(b.missing).toStrictEqual(a.missing);
		expect({ ...b.renders }).toStrictEqual({ ...a.renders });
	});

	it('a bed render: the PCM is the same, sample for sample (transferred back)', async () => {
		const { audioWorld } = await import('../src/sound-design/bed.ts');
		const world = await audioWorld(doc.doc, doc.seqId, base.registry);
		const op: MeasureOp = {
			kind: 'render',
			req: {
				snapshot: world.snapshot,
				media: world.mediaFiles,
				range: { start: 0, end: 120 },
				clipIds: [ids.music!, ids.hero!],
				prune: true,
			},
		};
		const a = await new SoundDesignMeasurer(null).run(op, { ff: base.ff });
		const b = await worker.run(op, { ff: base.ff });
		expect(a.pcm.channels.length).toBe(2);
		expect(b.pcm.startSample).toBe(a.pcm.startSample);
		expect(b.truePeakDb).toBe(a.truePeakDb);
		for (let c = 0; c < a.pcm.channels.length; c++)
			expect(Buffer.from(b.pcm.channels[c]!.buffer).equals(Buffer.from(a.pcm.channels[c]!.buffer))).toBe(
				true,
			);
	});

	it('cancelling a render on the worker rejects at once and leaves the pool usable', async () => {
		const { audioWorld } = await import('../src/sound-design/bed.ts');
		const world = await audioWorld(doc.doc, doc.seqId, base.registry);
		const ac = new AbortController();
		const op: MeasureOp = {
			kind: 'render',
			req: {
				snapshot: world.snapshot,
				media: world.mediaFiles,
				range: { start: 0, end: 300 },
				clipIds: [ids.music!],
			},
		};
		const p = worker.run(op, { ff: base.ff, signal: ac.signal });
		setTimeout(() => ac.abort(), 5);
		await expect(p).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		const again = await worker.run(
			{ ...op, req: { ...op.req, range: { start: 0, end: 10 } } },
			{ ff: base.ff },
		);
		expect(again.pcm.channels[0]!.length).toBeGreaterThan(0);
	});
});

/** A scripted fake worker: answers `ready` (unless told not to) and each request per `behave`. */
class FakeWorker {
	static made: FakeWorker[] = [];
	terminated = false;
	posted: MeasureWorkerRequest[] = [];
	private handlers: Record<string, ((x: never) => void)[]> = {};
	constructor(
		private readonly behave: (w: FakeWorker, m: MeasureWorkerRequest) => void,
		ready = true,
	) {
		FakeWorker.made.push(this);
		if (ready) setTimeout(() => this.emit('message', { id: 0, ready: true }), 0);
	}
	postMessage(m: MeasureWorkerRequest): void {
		this.posted.push(m);
		this.behave(this, m);
	}
	terminate(): void {
		this.terminated = true;
	}
	on(event: string, fn: (x: never) => void): unknown {
		(this.handlers[event] ??= []).push(fn);
		return this;
	}
	emit(event: 'message', m: MeasureWorkerResponse): void;
	emit(event: 'error', e: Error): void;
	emit(event: 'exit', code: number): void;
	emit(event: string, x: unknown): void {
		for (const fn of this.handlers[event] ?? []) (fn as (x: unknown) => void)(x);
	}
}

const FF = new Ffmpeg({ ffmpeg: null, ffprobe: null });
const BANDS: MeasureOp = { kind: 'bedBands', req: { channels: [], sampleRate: 48_000, items: [] } };
const URL_ = new URL('file:///fake/sd-measure-worker.mjs');
const reply = (w: FakeWorker, m: MeasureWorkerRequest, result: unknown = []) => {
	if ('id' in m) setTimeout(() => w.emit('message', { id: m.id, ok: true, result }), 0);
};

describe('measurement pool lifecycle (fake workers)', () => {
	afterEach(() => vi.useRealTimers());
	it('resolves the worker module: env, bundle, tsx source, or none', () => {
		expect(resolveMeasureWorker({ JASPER_SD_MEASURE_WORKER: 'off' })).toBeNull();
		expect(resolveMeasureWorker({ JASPER_SD_MEASURE_WORKER: '/x/w.mjs' })?.href).toBe('file:///x/w.mjs');
		const src = pathToFileURL(join(HERE, '..', 'src', 'sound-design', 'measure-pool.ts')).href;
		expect(resolveMeasureWorker({}, src, ['--import', 'file:///x/tsx/dist/loader.mjs'])?.pathname).toMatch(
			/measure-worker\.ts$/,
		);
		expect(resolveMeasureWorker({}, src, [])).toBeNull();
	});

	it('no worker can start: measures in-thread', async () => {
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			createWorker: () => {
				throw new Error('no threads here');
			},
		});
		expect(await m.run(BANDS, { ff: FF })).toEqual([]);
	});

	it('a worker that crashes: its requests fail with MEASURE_FAILED (retryable), the next one gets a new worker', async () => {
		FakeWorker.made = [];
		let crash = true;
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			createWorker: () =>
				new FakeWorker((w, msg) => {
					if (crash) setTimeout(() => w.emit('exit', 1), 0);
					else reply(w, msg);
				}),
		});
		await expect(m.run(BANDS, { ff: FF })).rejects.toMatchObject({ code: 'MEASURE_FAILED', retryable: true });
		crash = false;
		expect(await m.run(BANDS, { ff: FF })).toEqual([]);
		expect(FakeWorker.made.length).toBe(2);
		await m.close();
	});

	it('an uncaught error in the worker: the same (never a hung request)', async () => {
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			createWorker: () => new FakeWorker((w) => setTimeout(() => w.emit('error', new Error('boom')), 0)),
		});
		await expect(m.run(BANDS, { ff: FF })).rejects.toMatchObject({
			code: 'MEASURE_FAILED',
			message: expect.stringMatching(/boom/),
		});
		await m.close();
	});

	it('a failed op keeps its code (an ffmpeg failure is a TOOL_FAILED), the worker stays', async () => {
		FakeWorker.made = [];
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			createWorker: () =>
				new FakeWorker((w, msg) => {
					if ('id' in msg)
						setTimeout(
							() =>
								w.emit('message', {
									id: msg.id,
									ok: false,
									message: 'ffmpeg exited 1',
									aborted: false,
									code: 'TOOL_FAILED',
								}),
							0,
						);
				}),
		});
		await expect(m.run(BANDS, { ff: FF })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
		await m.close();
	});

	it('a timeout ends the worker; its other requests move to a new one and complete', async () => {
		vi.useFakeTimers();
		FakeWorker.made = [];
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			size: 1,
			createWorker: () =>
				new FakeWorker((w, msg) => {
					// the first worker never answers; later ones do
					if (FakeWorker.made.indexOf(w) > 0) reply(w, msg, ['ok']);
				}),
		});
		const slow = m.run(BANDS, { ff: FF }, { timeoutMs: 50 });
		const other = m.run(BANDS, { ff: FF }, { timeoutMs: 5_000 });
		const timedOut = expect(slow).rejects.toMatchObject({ code: 'MEASURE_TIMEOUT', retryable: true });
		await vi.advanceTimersByTimeAsync(52);
		await timedOut;
		expect(await other).toEqual(['ok']);
		expect(FakeWorker.made[0]!.terminated).toBe(true);
		expect(FakeWorker.made.length).toBe(2);
		await m.close();
	});

	it('cancel rejects at once; a worker that does not stop within the grace is ended', async () => {
		vi.useFakeTimers();
		FakeWorker.made = [];
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			cancelGraceMs: 30,
			createWorker: () => new FakeWorker(() => {}),
		});
		const ac = new AbortController();
		const p = m.run(BANDS, { ff: FF, signal: ac.signal });
		await vi.advanceTimersByTimeAsync(1);
		ac.abort();
		await expect(p).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		const w = FakeWorker.made[0]!;
		expect(w.posted.some((x) => 'cancel' in x)).toBe(true);
		expect(w.terminated).toBe(false);
		await vi.advanceTimersByTimeAsync(30);
		expect(w.terminated).toBe(true);
		await expect(m.run(BANDS, { ff: FF, signal: ac.signal })).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
		await m.close();
	});

	it('a worker that never starts: in-thread after the start timeout', async () => {
		vi.useFakeTimers();
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			startTimeoutMs: 30,
			createWorker: () => new FakeWorker(() => {}, false),
		});
		const pending = m.run(BANDS, { ff: FF });
		await vi.advanceTimersByTimeAsync(30);
		expect(await pending).toEqual([]);
	});

	it('at most `size` workers; idle ones are stopped; close interrupts what runs', async () => {
		vi.useFakeTimers();
		FakeWorker.made = [];
		const m = new SoundDesignMeasurer(URL_, () => {}, {
			size: 2,
			idleMs: 30,
			createWorker: () => new FakeWorker((w, msg) => setTimeout(() => reply(w, msg), 20)),
		});
		const pending = Promise.all(Array.from({ length: 6 }, () => m.run(BANDS, { ff: FF })));
		await vi.advanceTimersByTimeAsync(22);
		await pending;
		expect(FakeWorker.made.length).toBe(2);
		await vi.advanceTimersByTimeAsync(30);
		expect(FakeWorker.made.every((w) => w.terminated)).toBe(true);
		const hung = new SoundDesignMeasurer(URL_, () => {}, { createWorker: () => new FakeWorker(() => {}) });
		const p = hung.run(BANDS, { ff: FF });
		await vi.advanceTimersByTimeAsync(1);
		const interrupted = expect(p).rejects.toMatchObject({ code: 'INTERRUPTED' });
		await hung.close();
		await interrupted;
	});
});
