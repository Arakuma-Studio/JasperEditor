// Bakes beside the composite (docs/wp-notes/export-performance.md §13, service.ts `runNative`): an extension defers a
// layer's bake (`NativePrepareContext.defer`); the segments that do not draw it start at once and the one that does
// starts when it is ready, rendering the frames of an export that waited for the bake; a failed bake fails the export
// with its error and stops the running segments; a cancelled export stops the bake and the segments.
import { spawnSync } from 'node:child_process';
import { ExportResultSchema } from '@jasper/api';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import type { LayerOverride, NativeExtension } from '../src/export/native-ext.ts';
import { JobError } from '../src/jobs/types.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ totalSlots: 8 });
}, 180_000);
afterAll(closeApps);
afterEach(() => {
	delete process.env.JASPER_EXPORT_SEGMENTS;
	delete process.env.JASPER_EXPORT_SEGMENT_MIN_SEC;
});

/** 720p30, 150 frames: V1 clip-a | clip-b (cut at 60) | frame-code; V2 a solid on [110, 140), the baked layer. */
async function doc() {
	const d = new DocBuilder('hd-720p-30');
	const [a, b, code] = await Promise.all(
		['clip-a.mp4', 'clip-b.mp4', 'frame-code.mp4'].map(async (f) =>
			d.addMedia(await register(app, fixture(f))),
		),
	);
	const place = (media: string, at: number, inF: number, outF: number) => ({
		type: 'clip.place',
		source: { mediaId: media },
		at,
		sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
	});
	const { refs } = d.tx([
		place(a!, 0, 0, 60),
		place(b!, 60, 10, 70),
		place(code!, 120, 0, 30),
		{ type: 'clip.addSolid', at: 110, duration: 30, track: 'V2', color: [0.2, 0.4, 1, 1], ref: '$baked' },
	]);
	return { d, baked: refs.$baked! };
}

/**
 * A test double of a slow bake: the clip `clipId` is drawn from `still.png` once its gate opens. With `defer` it bakes
 * beside the composite (`ctx.defer`); otherwise (or where the export offers no `defer`) `prepare` waits for the gate.
 */
function slowBake(clipId: string, o: { defer: boolean }) {
	const gate = {} as { promise: Promise<void>; open(): void; fail(e: unknown): void };
	gate.promise = new Promise<void>((resolve, reject) => {
		gate.open = resolve;
		gate.fail = reject;
	});
	gate.promise.catch(() => undefined);
	const state = { deferred: false, signal: null as AbortSignal | null };
	const ext: NativeExtension = {
		id: 'test-slow-bake',
		claimsLayer: (c) => c.clipId === clipId,
		async prepare(planned, ctx) {
			const prepared = new Map<string, LayerOverride | 'pending'>();
			const clip = planned.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;
			const signal = ctx.backgroundSignal ?? ctx.signal;
			state.signal = signal;
			signal.addEventListener('abort', () => gate.fail(new JobError('JOB_CANCELLED', 'Cancelled')), {
				once: true,
			});
			const done = gate.promise.then(() => {
				prepared.set(clipId, {
					path: fixture('still.png'),
					space: 'sequence',
					startFrame: clip.start,
					still: true,
				});
			});
			done.catch(() => undefined);
			if (!o.defer || !ctx.defer || !ctx.background) {
				gate.open();
				await done;
				return prepared;
			}
			state.deferred = true;
			prepared.set(clipId, 'pending');
			ctx.background(done);
			ctx.defer({ clipIds: [clipId], start: clip.start, end: clip.start + clip.duration, ready: done });
			return prepared;
		},
		override(c, prepared) {
			const e = (prepared as Map<string, LayerOverride | 'pending'> | undefined)?.get(c.clipId);
			if (e === 'pending') throw new Error(`"${c.name}" was read before its bake was ready`);
			return e ?? null;
		},
	};
	onTestFinished(coreServices(app).exports.registerNativeExtension(ext));
	return { gate, state };
}

/** Records the segment composites as they start; `onStart` runs at the first. */
function watchSegments(onStart: () => void) {
	const core = coreServices(app);
	const run = core.ffmpeg.run;
	const started: { index: number; signal: AbortSignal }[] = [];
	core.ffmpeg.run = (args, options = {}) => {
		const m = /segment-(\d)\.mov$/.exec(args.at(-1) ?? '');
		if (m) {
			started.push({ index: Number(m[1]), signal: options.signal! });
			if (started.length === 1) onStart();
		}
		return run.call(core.ffmpeg, args, options);
	};
	onTestFinished(() => {
		core.ffmpeg.run = run;
	});
	return started;
}

const settings = (d: DocBuilder) => ({
	sequenceId: d.seqId,
	range: { type: 'entire' },
	container: 'mov',
	engine: 'native',
	video: {
		codec: 'prores',
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
});

async function start(d: DocBuilder): Promise<string> {
	// three segments: [0, 60) (the boundary moves to the cut), [60, 100), [100, 150) — only the last draws the solid
	process.env.JASPER_EXPORT_SEGMENTS = '3';
	process.env.JASPER_EXPORT_SEGMENT_MIN_SEC = '0.5';
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d) },
	});
	expect(r.statusCode, r.body).toBe(202);
	return r.json().id as string;
}

function frameHashes(file: string): string[] {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], {
		encoding: 'utf8',
		maxBuffer: 64 << 20,
	});
	return r.stdout
		.split('\n')
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => l.split(',').at(-1)!.trim());
}

describe('bakes beside the composite (native segments)', { timeout: 600_000 }, () => {
	it('segments that do not draw a baking layer start before its bake ends; the result equals the waited export', async () => {
		const { d, baked } = await doc();
		const core = coreServices(app);
		const waited = await (async () => {
			slowBake(baked, { defer: false });
			const id = await start(d);
			const done = await core.queue.wait(id);
			expect(done.error, JSON.stringify(done.error)).toBeUndefined();
			return (await core.exports.outputFile(id))!;
		})();
		const { gate, state } = slowBake(baked, { defer: true });
		let pendingAtFirst: boolean | null = null;
		const started = watchSegments(() => {
			pendingAtFirst = state.deferred;
			gate.open();
		});
		const id = await start(d);
		const done = await core.queue.wait(id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		expect(pendingAtFirst).toBe(true);
		// the segment drawing the solid started last, once the bake was ready
		expect(
			started
				.map((s) => s.index)
				.slice(0, 2)
				.sort(),
		).toEqual([0, 1]);
		expect(started.at(-1)!.index).toBe(2);
		const result = ExportResultSchema.parse(done.result);
		expect(result.pipeline).toMatchObject({ segments: 3 });
		// the bake phase lasts into the encode
		const { bake, encode } = result.timings!.phases;
		expect(bake!.startMs + bake!.ms).toBeGreaterThanOrEqual(encode!.startMs);
		const file = (await core.exports.outputFile(id))!;
		expect(frameHashes(file)).toEqual(frameHashes(waited));
	});

	it('a failed bake fails the export with its error and stops the running segments; its segment never starts', async () => {
		const { d, baked } = await doc();
		const { gate, state } = slowBake(baked, { defer: true });
		let pendingAtFirst: boolean | null = null;
		const started = watchSegments(() => {
			pendingAtFirst = state.deferred;
			gate.fail(new JobError('LAYER_BAKE_FAILED', 'the test bake exploded', true));
		});
		const id = await start(d);
		const done = await coreServices(app).queue.wait(id);
		expect(pendingAtFirst).toBe(true);
		expect(done.state).toBe('failed');
		expect(done.error?.message).toMatch(/the test bake exploded/);
		expect(started.map((s) => s.index)).not.toContain(2);
		expect(started.every((s) => s.signal.aborted)).toBe(true);
	});

	it('cancelling stops the bake and every running segment', async () => {
		const { d, baked } = await doc();
		const core = coreServices(app);
		const { state } = slowBake(baked, { defer: true });
		let pendingAtFirst: boolean | null = null;
		let id = '';
		let cancel!: Promise<number>;
		const started = watchSegments(() => {
			pendingAtFirst = state.deferred;
			cancel = app
				.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H })
				.then((r) => r.statusCode);
		});
		id = await start(d);
		const done = await core.queue.wait(id);
		expect(await cancel).toBeLessThan(300);
		expect(pendingAtFirst).toBe(true);
		expect(done.state).toBe('cancelled');
		expect(state.signal?.aborted).toBe(true);
		expect(started.length).toBeGreaterThan(0);
		expect(started.every((s) => s.signal.aborted)).toBe(true);
		expect(await core.exports.outputFile(id)).toBeNull();
	});
});

describe('bake progress on the export job', { timeout: 600_000 }, () => {
	it('the job moves its bar and names the bake as the bakes report, and the composite goes on from there', async () => {
		// reported: `get_job` showed no progress for the 3.5 min bake phase of an export (a stall looked the same)
		const { d, baked } = await doc();
		const core = coreServices(app);
		const deferred = () => {
			let resolve!: () => void;
			const promise = new Promise<void>((r) => {
				resolve = r;
			});
			return { promise, resolve };
		};
		// two fake child bakes: each reports, then waits for the test to have read the job
		const reported = [deferred(), deferred()];
		const read = [deferred(), deferred()];
		const ext: NativeExtension = {
			id: 'test-reporting-bake',
			claimsLayer: (c) => c.clipId === baked,
			async prepare(planned, ctx) {
				const clip = planned.snapshot.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === baked)!;
				for (const [i, text] of [
					'Baking graphics 0/2 (Solid) · 40 %',
					'Baking graphics 1/2 (Solid) · 80 %',
				].entries()) {
					if (ctx.progress) ctx.progress((i + 1) * 0.4, text);
					else ctx.stage(text);
					reported[i]!.resolve();
					await read[i]!.promise;
				}
				return new Map([
					[baked, { path: fixture('still.png'), space: 'sequence', startFrame: clip.start, still: true }],
				]);
			},
			override: (c, prepared) => (prepared as Map<string, LayerOverride>).get(c.clipId) ?? null,
		};
		onTestFinished(core.exports.registerNativeExtension(ext));
		let atComposite: number | null = null;
		let id = '';
		watchSegments(() => {
			atComposite = core.queue.get(id)!.progress;
		});
		id = await start(d);
		const seen: { progress: number | null; stage?: string }[] = [];
		for (const i of [0, 1]) {
			await reported[i]!.promise;
			const job = core.queue.get(id)!;
			seen.push({ progress: job.progress, stage: job.stage });
			read[i]!.resolve();
		}
		const done = await core.queue.wait(id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		expect(seen.map((s) => s.stage)).toEqual([
			'Baking graphics 0/2 (Solid) · 40 %',
			'Baking graphics 1/2 (Solid) · 80 %',
		]);
		const [first, second] = seen.map((s) => s.progress ?? 0);
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(first!);
		// the bar does not go back when the composite starts
		expect(atComposite).toBeGreaterThanOrEqual(second!);
	});
});
