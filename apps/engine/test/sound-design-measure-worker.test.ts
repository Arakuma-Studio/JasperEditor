// The sound-design measurement worker threads (wp-note WP6.5b item 7; measure-pool.ts / measure-worker.ts): the solo and
// bed renders and their band analysis give BIT-IDENTICAL results on a worker and in-thread (the worker is bundled with
// esbuild, as the engine build does). Small real Worker URL fixtures exercise failures and deadlines through the
// same protocol, with file events synchronizing receipt and controlled clocks advancing the documented deadlines.
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { measureLoudness } from '@jasper/audio-dsp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DeliveryRunner, solveDelivery } from '../src/audio/deliver.ts';
import { WAV_F32_HEADER_BYTES, wavHeaderF32, writeDeliveryWav } from '../src/audio/mixdown.ts';
import { MeasureCache, type MeasureDeps, measureSfxEvents } from '../src/sound-design/bed.ts';
import type { MeasureOp } from '../src/sound-design/measure-core.ts';
import {
	closeSoundDesignMeasurer,
	exportAudioWorkers,
	SoundDesignMeasurer,
	soundDesignMeasurer,
} from '../src/sound-design/measure-pool.ts';
import { Ffmpeg } from '../src/tools/ffmpeg.ts';
import { coreServices } from '../src/tools/services.ts';
import { TEST_FFMPEG, TEST_FFPROBE } from './fixtures.ts';
import { closeApps, DocBuilder, makeApp, register, type TestApp } from './helpers.ts';
import { loudMix } from './loud-fixture.ts';
import { provenance, writeBedFixture } from './sound-bed-fixture.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

let bundledWorker: Promise<string> | undefined;
const artifactDirs: string[] = [];

function bundleWorker(): Promise<string> {
	return (bundledWorker ??= (async () => {
		const { build } = await import('esbuild');
		const dir = mkdtempSync(join(tmpdir(), 'jasper-sd-worker-'));
		artifactDirs.push(dir);
		const out = join(dir, 'sd-measure-worker.mjs');
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
	})());
}
afterAll(() => {
	for (const dir of artifactDirs) rmSync(dir, { recursive: true, force: true });
});

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
		// A real decoder failure must retain its error code, without poisoning the worker's next operation.
		const brokenFfmpeg = new Ffmpeg({ ffmpeg: process.execPath, ffprobe: process.execPath });
		await expect(worker.run(op, { ff: brokenFfmpeg })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
		const b = await worker.run(op, { ff: base.ff });
		expect(a.pcm.channels.length).toBe(2);
		expect(b.pcm.startSample).toBe(a.pcm.startSample);
		expect(b.truePeakDb).toBe(a.truePeakDb);
		for (let c = 0; c < a.pcm.channels.length; c++)
			expect(Buffer.from(b.pcm.channels[c]!.buffer).equals(Buffer.from(a.pcm.channels[c]!.buffer))).toBe(
				true,
			);
	});
});

const FF = new Ffmpeg({ ffmpeg: null, ffprobe: null });
const BANDS: MeasureOp = {
	kind: 'bedBands',
	req: {
		channels: [new Float32Array(4_800)],
		sampleRate: 48_000,
		items: [{ rel: { start: 0, end: 0.1 }, window: { start: 0, end: 0.1 }, weight: 'support' }],
	},
};
// Documented octave-band floor for actual silent PCM, independent of the worker's return transport.
const SILENCE = [{ bedBandsDb: [-120, -120, -120, -120, -120, -120, -120], bedLocalPeakLu: null }];
const pools: SoundDesignMeasurer[] = [];
const fixtureDirs: string[] = [];
const observers = new Set<FSWatcher>();

/** A real Worker module; marker files expose only its receipt/start, without a production scheduling hook. */
function protocolWorker(body: (dir: string) => string) {
	const dir = mkdtempSync(join(tmpdir(), 'jasper-measure-protocol-'));
	fixtureDirs.push(dir);
	const trace = join(dir, 'trace');
	const file = join(dir, 'worker.mjs');
	writeFileSync(
		file,
		`
		import { parentPort, threadId } from 'node:worker_threads';
		import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
		const record = (kind) => appendFileSync(${JSON.stringify(trace)}, kind + ':' + threadId + '\\n');
		record('boot');
		parentPort.on('message', (m) => record('id' in m ? 'request' : 'cancel'));
		${body(dir)}
	`,
	);
	const pool = new SoundDesignMeasurer(pathToFileURL(file));
	pools.push(pool);
	const ids = (kind: string) =>
		(existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [])
			.filter((line) => line.startsWith(`${kind}:`))
			.map((line) => Number(line.split(':')[1]));
	const received = (kind = 'request', count = 1) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (ids(kind).length < count) return;
				observer.close();
				observers.delete(observer);
				resolve();
			};
			const observer = watch(dir, check);
			observers.add(observer);
			check();
		});
	return { pool, ids, received };
}

/** First process injects a real fault or stall; later processes run the actual bundled DSP worker. */
async function faultyFirstWorker(onMessage = '') {
	const actual = JSON.stringify(pathToFileURL(await bundleWorker()).href);
	return protocolWorker(
		(dir) => `
		const first = ${JSON.stringify(join(dir, 'first'))};
		if (!existsSync(first)) {
			writeFileSync(first, '');
			parentPort.on('message', () => { ${onMessage} });
			parentPort.postMessage({ id: 0, ready: true });
		} else {
			await import(${actual});
		}
	`,
	);
}

afterEach(async () => {
	for (const observer of observers) observer.close();
	observers.clear();
	await Promise.all(pools.splice(0).map((pool) => pool.close()));
	for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});

describe('export audio on the measurement workers (wp-note export-performance "Audio delivery")', {
	timeout: 600_000,
}, () => {
	it('a delivery whose passes and decoded checks run on worker threads writes the same WAV, encode and outcome', async () => {
		const SR = 48_000;
		const ff = new Ffmpeg({ ffmpeg: TEST_FFMPEG, ffprobe: TEST_FFPROBE });
		const dir = mkdtempSync(join(tmpdir(), 'jasper-export-audio-'));
		artifactDirs.push(dir);
		const mix = loudMix(8, SR);
		const n = mix[0]!.length;
		const pcm = new Float32Array(n * 2);
		for (let i = 0; i < n; i++) {
			pcm[2 * i] = mix[0]![i]!;
			pcm[2 * i + 1] = mix[1]![i]!;
		}
		const p1 = { path: join(dir, 'pass1.wav'), headerBytes: WAV_F32_HEADER_BYTES };
		writeFileSync(p1.path, Buffer.concat([wavHeaderF32(2, SR, n), Buffer.from(pcm.buffer)]));
		const delivery = async (tag: string, runner?: DeliveryRunner) => {
			const scratch = join(dir, tag);
			mkdirSync(scratch);
			const out = join(scratch, 'mix.wav');
			const r = await solveDelivery({
				ff,
				pass1: p1,
				sampleRate: SR,
				channels: 2,
				total: n,
				before: measureLoudness(mix, SR),
				targetLufs: -14,
				truePeakDb: -1,
				codec: { codec: 'aac', bitrateKbps: 128, sampleRate: SR, channels: 2 },
				soxr: false,
				scratchDir: scratch,
				outPath: out,
				...(runner ? { runner } : {}),
				// as renderMixdown writes its passes (on the runner when there is one)
				write: (params, path = out) =>
					runner
						? runner.pass({
								pass1: p1,
								sampleRate: SR,
								channels: 2,
								total: n,
								params,
								out: path,
								truePeak: true,
							})
						: writeDeliveryWav(p1, path, SR, 2, n, params),
			});
			return { r, wav: readFileSync(out), encoded: readFileSync(r.encoded!) };
		};
		const previous = process.env.JASPER_SD_MEASURE_WORKER;
		await closeSoundDesignMeasurer();
		process.env.JASPER_SD_MEASURE_WORKER = await bundleWorker();
		try {
			const here = await delivery('here');
			// (a worker that cannot start logs it and measures in-thread)
			const logs: string[] = [];
			const workers = await delivery(
				'workers',
				exportAudioWorkers({ ff }, n / SR, (m) => logs.push(m)).runner,
			);
			expect(logs).toEqual([]);
			expect(workers.wav.equals(here.wav)).toBe(true);
			expect(workers.encoded.equals(here.encoded)).toBe(true);
			const outcome = ({ r }: typeof here) => ({
				...r,
				params: { ...r.params, correction: r.params.correction && [...r.params.correction] },
				encoded: null,
				timings: null,
			});
			expect(outcome(workers)).toEqual(outcome(here));
		} finally {
			await closeSoundDesignMeasurer();
			if (previous === undefined) delete process.env.JASPER_SD_MEASURE_WORKER;
			else process.env.JASPER_SD_MEASURE_WORKER = previous;
		}
	});
});

describe('measurement worker URL and lifecycle', () => {
	it('explicit off, missing and never-ready workers use the real in-thread measurement', async () => {
		const previous = process.env.JASPER_SD_MEASURE_WORKER;
		await closeSoundDesignMeasurer();
		try {
			for (const disabled of ['off', '0']) {
				process.env.JASPER_SD_MEASURE_WORKER = disabled;
				const warnings: string[] = [];
				expect(await soundDesignMeasurer((message) => warnings.push(message)).run(BANDS, { ff: FF })).toEqual(
					SILENCE,
				);
				expect(warnings).toEqual([]);
				await closeSoundDesignMeasurer();
			}
		} finally {
			await closeSoundDesignMeasurer();
			if (previous === undefined) delete process.env.JASPER_SD_MEASURE_WORKER;
			else process.env.JASPER_SD_MEASURE_WORKER = previous;
		}
		const missingDir = mkdtempSync(join(tmpdir(), 'jasper-no-measure-worker-'));
		fixtureDirs.push(missingDir);
		const missing = new SoundDesignMeasurer(pathToFileURL(join(missingDir, 'missing.mjs')));
		pools.push(missing);
		expect(await missing.run(BANDS, { ff: FF })).toEqual(SILENCE);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const fixture = protocolWorker(() => '');
		const pending = fixture.pool.run(BANDS, { ff: FF });
		await fixture.received('boot');
		await vi.advanceTimersByTimeAsync(120_000);
		expect(await pending).toEqual(SILENCE);
	});

	it('a real uncaught worker error rejects as retryable and the next request succeeds', async () => {
		const fixture = await faultyFirstWorker("throw new Error('worker crashed');");
		await expect(fixture.pool.run(BANDS, { ff: FF })).rejects.toMatchObject({
			code: 'MEASURE_FAILED',
			retryable: true,
		});
		expect(await fixture.pool.run(BANDS, { ff: FF })).toEqual(SILENCE);
	});

	it('the ten-minute deadline rejects the stalled operation and recovers its pending sibling', async () => {
		const fixture = await faultyFirstWorker();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const first = Promise.allSettled([fixture.pool.run(BANDS, { ff: FF })]);
		await fixture.received();
		// Later requests have a later deadline; one goes to the second worker, one shares the stalled worker.
		await vi.advanceTimersByTimeAsync(1);
		const other = fixture.pool.run(BANDS, { ff: FF });
		const moved = Promise.allSettled([fixture.pool.run(BANDS, { ff: FF })]);
		await fixture.received('request', 3);
		expect(new Set(fixture.ids('request')).size).toBe(2);
		expect(await other).toEqual(SILENCE);
		await vi.advanceTimersByTimeAsync(599_999);
		expect((await first)[0]).toMatchObject({
			status: 'rejected',
			reason: { code: 'MEASURE_TIMEOUT', retryable: true },
		});
		expect((await moved)[0]).toEqual({ status: 'fulfilled', value: SILENCE });
	});

	it('cancel rejects immediately and replaces a worker that ignores it after the five-second grace', async () => {
		const fixture = await faultyFirstWorker();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const ac = new AbortController();
		const cancelled = Promise.allSettled([fixture.pool.run(BANDS, { ff: FF, signal: ac.signal })]);
		await fixture.received();
		ac.abort();
		expect((await cancelled)[0]).toMatchObject({ status: 'rejected', reason: { code: 'JOB_CANCELLED' } });
		await fixture.received('cancel');
		const next = fixture.pool.run(BANDS, { ff: FF });
		await fixture.received('request', 2);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await next).toEqual(SILENCE);
		await expect(fixture.pool.run(BANDS, { ff: FF, signal: ac.signal })).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
	});

	it('uses at most two workers, retires them after thirty seconds idle, and interrupts in-flight work on close', async () => {
		const actual = JSON.stringify(pathToFileURL(await bundleWorker()).href);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const fixture = protocolWorker(() => `await import(${actual});`);
		expect(await Promise.all(Array.from({ length: 6 }, () => fixture.pool.run(BANDS, { ff: FF })))).toEqual(
			Array(6).fill(SILENCE),
		);
		const original = new Set(fixture.ids('request'));
		expect(original.size).toBe(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(await fixture.pool.run(BANDS, { ff: FF })).toEqual(SILENCE);
		expect(original.has(fixture.ids('request').at(-1)!)).toBe(false);
		const stalled = protocolWorker(() => 'parentPort.postMessage({ id: 0, ready: true });');
		const interrupted = Promise.allSettled([stalled.pool.run(BANDS, { ff: FF })]);
		await stalled.received();
		await stalled.pool.close();
		expect((await interrupted)[0]).toMatchObject({ status: 'rejected', reason: { code: 'INTERRUPTED' } });
	});
});
