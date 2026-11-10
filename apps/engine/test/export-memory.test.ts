// Memory of the native composite with many source inputs (AGENTS §0; docs/wp-notes/export-performance.md §6): the
// user's 15 min project (380 inputs of one recording) ran ffmpeg out of memory before its first frame, because every
// input's decoder kept a thread's frame buffers per CPU. Each file input's decoder threads are now capped in the
// built command, and the segment plan keeps the graphs running at once under the memory budget — more, shorter
// segments, fewer at a time — or refuses the native path by name when even the shortest segment alone would not fit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compositeProfile, decoderThreadsFor, estimateFrom } from '../src/export/memory.ts';
import { buildNativeGraph } from '../src/export/native.ts';
import { planPictureSegments, segmentPolicyFromEnv } from '../src/export/segments.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
let doc: DocBuilder;
let planned: Awaited<ReturnType<typeof planOf>>;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
	doc = await cutsDoc();
	planned = await planOf(doc);
}, 180_000);
afterAll(closeApps);

const CUTS = 40;
const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 1280,
		height: 720,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 28 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

/** 40 one-second cuts of a 1080p recording on V1 (40 inputs of one file, as a cut-down interview). */
async function cutsDoc() {
	const a = await register(app, fixture('clip-a.mp4'));
	const d = new DocBuilder();
	const m = d.addMedia(a);
	d.tx(
		Array.from({ length: CUTS }, (_, i) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at: i * 30,
			sourceRange: { in: { sourceFrames: (i * 7) % 260 }, out: { sourceFrames: ((i * 7) % 260) + 30 } },
		})),
	);
	return d;
}

async function planOf(d: DocBuilder) {
	return coreServices(app).exports.plan({
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: settings(d.seqId) as never,
	});
}

describe('composite memory with many inputs (AS-074)', () => {
	it('caps the decoder threads of every file input of the composite', () => {
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mp4',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 24,
		});
		const files = g.args.flatMap((a, i) =>
			a === '-i' && !g.args[i + 1]!.startsWith('pipe:') && g.args[i - 2] !== 'lavfi' ? [i] : [],
		);
		expect(files.length).toBeGreaterThanOrEqual(CUTS);
		const want = String(decoderThreadsFor(24, files.length));
		expect(want).toBe('2');
		for (const i of files) {
			// `-threads N` among this input's own arguments (after the previous input's `-i <path>`)
			const own = g.args.slice(g.args.lastIndexOf('-i', i - 1) + 2, i);
			expect(own[own.indexOf('-threads') + 1], g.args[i + 1]).toBe(want);
		}
	});

	it('splits into more, shorter segments run fewer at a time to fit the budget, or refuses by name', () => {
		const snap = planned.snapshot;
		const profile = compositeProfile(snap);
		const estimate = (r: { start: number; end: number }, threads: number) =>
			estimateFrom(snap, profile, r, { threads }).bytes;
		const whole = estimate(snap.range, 8);
		const plan = (budget: number) =>
			planPictureSegments({
				snapshot: snap,
				output: planned.output,
				slots: 8,
				policy: { ...segmentPolicyFromEnv({}), minSec: 10, memoryMinSec: 1 },
				memory: { budget, estimate },
			});
		// enough memory: the speed plan (40 s / 10 s minimum, 8 slots / 3 → 2 at once)
		const roomy = plan(whole * 4);
		expect(roomy).toMatchObject({ concurrency: 2 });
		expect(roomy.segments).toHaveLength(2);
		expect(roomy.blocker).toBeUndefined();
		// 40 % of one graph: more segments, each graph smaller, never more at once than fits
		const tight = plan(whole * 0.4);
		expect(tight.blocker).toBeUndefined();
		expect(tight.segments.length).toBeGreaterThan(2);
		expect(tight.peakBytes).toBeLessThanOrEqual(whole * 0.4);
		expect(tight.segments[0]!.start).toBe(snap.range.start);
		expect(tight.segments.at(-1)!.end).toBe(snap.range.end);
		// not even one shortest segment fits: a named blocker, never a composite that runs out of memory
		const none = plan(1024 * 1024);
		expect(none.blocker).toMatch(/native composite needs ≈ \d+\.\d GB of memory/);
	});

	it('plans a range one graph cannot hold as segments instead of refusing it', async () => {
		const d = doc;
		const whole = estimateFrom(planned.snapshot, compositeProfile(planned.snapshot), planned.snapshot.range, {
			threads: 8,
		}).bytes;
		const budgetMb = Math.floor((whole * 0.5) / 1024 / 1024);
		process.env.JASPER_EXPORT_MEMORY_BUDGET_MB = String(budgetMb);
		process.env.JASPER_EXPORT_SEGMENT_MIN_SEC = '10';
		process.env.JASPER_EXPORT_SEGMENT_MEMORY_MIN_SEC = '1';
		try {
			const r = await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
			});
			expect(r.statusCode, r.body).toBe(200);
			const p = r.json() as {
				path: string;
				blockers: unknown[];
				pipeline: { segments: number; memoryBytes: number };
			};
			expect(p.blockers).toEqual([]);
			expect(p.path).toBe('native');
			expect(p.pipeline.segments).toBeGreaterThan(1);
			expect(p.pipeline.memoryBytes).toBeLessThanOrEqual(budgetMb * 1024 * 1024);
		} finally {
			delete process.env.JASPER_EXPORT_MEMORY_BUDGET_MB;
			delete process.env.JASPER_EXPORT_SEGMENT_MIN_SEC;
			delete process.env.JASPER_EXPORT_SEGMENT_MEMORY_MIN_SEC;
		}
	});
});
