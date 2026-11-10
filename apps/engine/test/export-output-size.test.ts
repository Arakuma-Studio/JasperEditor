// Compositing a downscaled export at its output size (apps/engine/src/export/output-size.ts; docs/wp-notes/
// export-performance.md §7): the plan says at what size the composite is drawn and why not at the output size; the
// built graph draws on an output-size canvas — sources scaled straight to their output-size boxes, no final
// downscale — and the exported picture matches the sequence-size composite scaled to the output (SSIM per frame).
import { ExportResultSchema, RenderPlanSchema } from '@jasper/api';
import { compareVideos } from '@jasper/testkit/oracle';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { outputSizeSnapshot, planCompositeSize } from '../src/export/output-size.ts';
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
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);
afterEach(() => {
	delete process.env.JASPER_EXPORT_COMPOSITE_SIZE;
});

const settings = (seqId: string, width = 640, height = 360) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mov',
	engine: 'native',
	video: {
		codec: 'prores',
		width,
		height,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
});

/** 1080p: clip-a | clip-b on V1, a scaled sub-pixel moving still on V2, a cropped solid on V3, a scaled picture-in-picture on V4 (on whole output pixels). */
async function doc() {
	const [a, b, still] = await Promise.all(
		['clip-a.mp4', 'clip-b.mp4', 'still.png'].map((f) => register(app, fixture(f))),
	);
	const d = new DocBuilder();
	const [ma, mb, ms] = [a!, b!, still!].map((m) => d.addMedia(m));
	const place = (
		media: string,
		at: number,
		inF: number,
		outF: number,
		extra: Record<string, unknown> = {},
	) => ({
		type: 'clip.place',
		source: { mediaId: media },
		at,
		sourceRange: { in: { sourceFrames: inF }, out: { sourceFrames: outF } },
		...extra,
	});
	const r = d.tx([
		place(ma!, 0, 0, 40),
		place(mb!, 40, 0, 50),
		place(ms!, 5, 0, 0, {
			tracks: { video: 'V2' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 2.5 } },
			ref: '$s',
		}),
		{ type: 'clip.addSolid', at: 10, duration: 60, track: 'V3', color: [0.9, 0.7, 0.1, 1], ref: '$solid' },
		place(ma!, 20, 100, 170, { tracks: { video: 'V4' }, ref: '$pip' }),
	]);
	const { $s: s, $solid: solid, $pip: pip } = r.refs as Record<string, string>;
	d.tx([
		{ type: 'param.set', target: ['clip', s!, 'transform', 'scale'], value: 35 },
		{
			type: 'keyframe.add',
			target: ['clip', s!, 'transform', 'position'],
			at: { sequenceFrame: 5 },
			value: [300.4, 260.6],
		},
		{
			type: 'keyframe.add',
			target: ['clip', s!, 'transform', 'position'],
			at: { sequenceFrame: 79 },
			value: [1500.2, 820.9],
		},
		{ type: 'param.set', target: ['clip', solid!, 'transform', 'scale'], value: 30 },
		{ type: 'param.set', target: ['clip', solid!, 'transform', 'position'], value: [1400, 300] },
		{
			type: 'effect.add',
			target: { clipId: solid! },
			effectId: 'jasper.crop',
			params: { left: 10, top: 20, right: 5, bottom: 15 },
		},
		{ type: 'param.set', target: ['clip', pip!, 'transform', 'scale'], value: 40 },
		{ type: 'param.set', target: ['clip', pip!, 'transform', 'position'], value: [480, 759] },
	]);
	return d;
}

async function exportFile(d: DocBuilder, s: ReturnType<typeof settings>) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(r.json().id))!,
		result: ExportResultSchema.parse(done.result),
	};
}

describe('composite at the output size', { timeout: 600_000 }, () => {
	it('the plan says the composite size, and why a downscaled export stays at the sequence size', async () => {
		const d = await doc();
		const plan = async (s: ReturnType<typeof settings>) =>
			RenderPlanSchema.parse(
				(
					await app.inject({
						method: 'POST',
						url: '/api/exports/plan',
						headers: JSON_H,
						payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: s },
					})
				).json(),
			).pipeline!;
		expect(await plan(settings(d.seqId))).toMatchObject({
			composite: { device: 'cpu', size: 'output' },
			compositeSize: { width: 640, height: 360 },
		});
		expect((await plan(settings(d.seqId, 1920, 1080))).composite).toEqual({
			device: 'cpu',
			size: 'sequence',
		});
		const letterboxed = await plan(settings(d.seqId, 640, 480));
		expect(letterboxed.composite.size).toBe('sequence');
		expect(letterboxed.composite.fallbackReasons).toEqual([expect.stringMatching(/aspect ratio/)]);
		d.tx([{ type: 'clip.addAdjustment', at: 0, duration: 20, track: 'V5' }]);
		const adjusted = await plan(settings(d.seqId));
		expect(adjusted.composite.size).toBe('sequence');
		expect(adjusted.composite.fallbackReasons).toEqual([expect.stringMatching(/1 adjustment layer/)]);
	});

	it('draws on an output-size canvas: sources scaled straight to their output boxes, no final downscale', async () => {
		const d = await doc();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const comp = planCompositeSize(planned.snapshot, planned.output);
		expect(comp).toEqual({ size: 'output', scale: 1 / 3, fallbackReasons: [] });
		const g = buildNativeGraph({
			snapshot: outputSizeSnapshot(planned.snapshot, comp),
			compositeScale: comp.scale,
			output: planned.output,
			outputFile: '/tmp/x.mov',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 4,
		});
		expect(g.inexact).toEqual([]);
		// the full-frame clips go from 1920×1080 to 640×360 in one resample; the 40 % picture-in-picture to 256×144
		expect(g.filter).toMatch(/scale=640:360:in_color_matrix/);
		expect(g.filter).toMatch(/scale=256:144:in_color_matrix/);
		expect(g.filter).not.toMatch(/1920x1080|scale=1920:1080/);
		expect(g.filter).not.toMatch(/force_original_aspect_ratio/);
	});

	it('matches the sequence-size composite scaled to the output (SSIM ≥ 0.98 per frame)', async () => {
		const d = await doc();
		const small = await exportFile(d, settings(d.seqId));
		process.env.JASPER_EXPORT_COMPOSITE_SIZE = 'sequence';
		const full = await exportFile(d, settings(d.seqId));
		expect(small.result.pipeline?.composite).toEqual({ device: 'cpu', size: 'output' });
		expect(full.result.pipeline?.composite.size).toBe('sequence');
		const q = compareVideos(full.file, small.file);
		expect(q.frames).toHaveLength(100);
		console.info(
			`output-size vs sequence-size composite: SSIM min ${Math.min(...q.frames.map((f) => f.ssim))}, mean ${q.ssim}`,
		);
		for (const [f, v] of q.frames.entries()) expect(v.ssim, `frame ${f}`).toBeGreaterThanOrEqual(0.98);
	});
});
